import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { searchJupiterTokens } from "./jupiterUtils";

const RPC_URL = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";

// Known token mint addresses
const KNOWN_TOKENS: Record<string, string> = {
  sol: "So11111111111111111111111111111111111111112",
  wsol: "So11111111111111111111111111111111111111112",
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  bonk: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  jitosol: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  jitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
};

// Global variable to store pending swap details
let pendingSwap: {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  inputToken: string;
  outputToken: string;
  slippage: number;
  quote: any;
} | null = null;

// Helper function to get wallet from private key
function getWalletFromPrivateKey(): Keypair | null {
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  
  if (!privateKey) {
    return null;
  }
  
  try {
    const secretKey = bs58.decode(privateKey);
    return Keypair.fromSecretKey(secretKey);
  } catch {
    try {
      const secretKey = new Uint8Array(JSON.parse(privateKey));
      return Keypair.fromSecretKey(secretKey);
    } catch {
      return null;
    }
  }
}

// Helper function to parse swap commands
function parseSwapCommand(input: string): {
  type: 'buy' | 'sell' | 'convert';
  amount: number;
  fromToken?: string;
  toToken: string;
} | null {
  console.log("🔍 Parsing swap command:", input);
  
  const normalizedInput = input.toLowerCase().trim();
  
  // Pattern 1: "buy X SOL of TOKEN" or "buy X sol worth of TOKEN"
  const buyPattern = /buy\s+(\d+(?:\.\d+)?)\s+sol\s+(?:of|worth\s+of)\s+([a-zA-Z0-9]+)/i;
  const buyMatch = normalizedInput.match(buyPattern);
  if (buyMatch) {
    return {
      type: 'buy',
      amount: parseFloat(buyMatch[1]),
      toToken: buyMatch[2].toLowerCase(),
    };
  }
  
  // Pattern 2: "sell X TOKEN for SOL" or "sell X TOKEN"
  const sellPattern = /sell\s+(\d+(?:\.\d+)?)\s+([a-zA-Z0-9]+)(?:\s+for\s+sol)?/i;
  const sellMatch = normalizedInput.match(sellPattern);
  if (sellMatch) {
    return {
      type: 'sell',
      amount: parseFloat(sellMatch[1]),
      fromToken: sellMatch[2].toLowerCase(),
      toToken: 'sol',
    };
  }
  
  // Pattern 3: "convert X TOKEN1 to TOKEN2" or "swap X TOKEN1 for TOKEN2"
  const convertPattern = /(?:convert|swap)\s+(\d+(?:\.\d+)?)\s+([a-zA-Z0-9]+)\s+(?:to|for)\s+([a-zA-Z0-9]+)/i;
  const convertMatch = normalizedInput.match(convertPattern);
  if (convertMatch) {
    return {
      type: 'convert',
      amount: parseFloat(convertMatch[1]),
      fromToken: convertMatch[2].toLowerCase(),
      toToken: convertMatch[3].toLowerCase(),
    };
  }
  
  console.log("❌ No swap pattern matched");
  return null;
}

// Helper function to resolve token mint address
async function resolveTokenMint(tokenSymbol: string): Promise<{ mint: string; name: string; symbol: string; decimals: number } | null> {
  console.log("🔍 Resolving token mint for:", tokenSymbol);
  
  // Check known tokens first
  const knownMint = KNOWN_TOKENS[tokenSymbol.toLowerCase()];
  if (knownMint) {
    const tokenData = {
      mint: knownMint,
      name: tokenSymbol.toUpperCase(),
      symbol: tokenSymbol.toUpperCase(),
      decimals: tokenSymbol.toLowerCase() === 'sol' ? 9 : 6, // Default decimals
    };
    console.log("✅ Found known token:", tokenData);
    return tokenData;
  }
  
  // Search using Jupiter tokens
  try {
    const results = await searchJupiterTokens(tokenSymbol);
    if (results.length > 0) {
      const token = results[0];
      const tokenData = {
        mint: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals || 6,
      };
      console.log("✅ Found token via Jupiter search:", tokenData);
      return tokenData;
    }
  } catch (error) {
    console.log("❌ Error searching for token:", error);
  }
  
  console.log("❌ Token not found:", tokenSymbol);
  return null;
}

// Helper function to get Jupiter quote
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 500 // 5% default
): Promise<any> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    });
    
    const response = await axios.get(`${JUPITER_QUOTE_API}?${params}`);
    return response.data;
  } catch (error: any) {
    console.error("❌ Jupiter quote error:", error.response?.data || error.message);
    throw new Error(`Failed to get quote: ${error.response?.data?.error || error.message}`);
  }
}

// Helper function to execute Jupiter swap
async function executeJupiterSwap(quote: any, wallet: Keypair): Promise<string> {
  try {
    // Get swap transaction
    const swapResponse = await axios.post(JUPITER_SWAP_API, {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 1000, // Very low priority fee
    });
    
    const { swapTransaction } = swapResponse.data;
    
    // Deserialize and sign transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    
    // Send transaction
    const connection = new Connection(RPC_URL);
    const signature = await connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: false,
    });
    
    // Confirm transaction
    await connection.confirmTransaction(signature, 'confirmed');
    
    return signature;
  } catch (error: any) {
    console.error("❌ Jupiter swap execution error:", error);
    throw new Error(`Swap execution failed: ${error.message}`);
  }
}

// Helper function to format numbers
function formatNumber(num: number, decimals: number = 6): string {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(decimals);
}

export const swapTokens = createTool({
  id: "swapTokens",
  description: "Swap tokens using Jupiter Exchange. Supports SOL→Token, Token→SOL, and Token→Token swaps with price preview and confirmation.",
  inputSchema: z.object({
    command: z.string().describe("Swap command like 'buy 0.01 SOL of BONK', 'sell 100 BONK', or 'convert 50 USDC to BONK'"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    swapDetails: z.object({
      inputToken: z.string(),
      outputToken: z.string(),
      inputAmount: z.number(),
      outputAmount: z.number(),
      priceImpact: z.number(),
      slippage: z.number(),
    }).optional(),
    confirmationRequired: z.boolean(),
  }),
  execute: async (args) => {
    const command = 
      args.command || 
      args.input?.command || 
      args.context?.command ||
      (typeof args === "string" ? args : "") ||
      "";
    
    console.log("🚀 swapTokens called with command:", command);
    
    // Parse the swap command
    const parsed = parseSwapCommand(command);
    if (!parsed) {
      return {
        success: false,
        message: `❌ Invalid swap command format. Please use one of these formats:
        
• **Buy tokens with SOL:** "buy 0.01 SOL of BONK"
• **Sell tokens for SOL:** "sell 100 BONK" 
• **Convert between tokens:** "convert 50 USDC to BONK"

Examples:
- buy 0.1 SOL of USDC
- sell 1000 BONK for SOL  
- convert 100 USDT to jitoSOL`,
        confirmationRequired: false,
      };
    }
    
    // Safety check - maximum swap limit
    if (parsed.amount > 10) {
      return {
        success: false,
        message: "❌ Swap amount exceeds safety limit of 10 SOL equivalent. For larger amounts, please contact the administrator.",
        confirmationRequired: false,
      };
    }
    
    // Check if wallet is configured
    const wallet = getWalletFromPrivateKey();
    if (!wallet) {
      return {
        success: false,
        message: "❌ Wallet not configured. Please set WALLET_PRIVATE_KEY in your environment variables.",
        confirmationRequired: false,
      };
    }
    
    try {
      // Resolve token mint addresses
      let inputToken, outputToken;
      
      if (parsed.type === 'buy') {
        // SOL → Token
        inputToken = await resolveTokenMint('sol');
        outputToken = await resolveTokenMint(parsed.toToken);
      } else if (parsed.type === 'sell') {
        // Token → SOL
        inputToken = await resolveTokenMint(parsed.fromToken!);
        outputToken = await resolveTokenMint('sol');
      } else {
        // Token → Token
        inputToken = await resolveTokenMint(parsed.fromToken!);
        outputToken = await resolveTokenMint(parsed.toToken);
      }
      
      if (!inputToken || !outputToken) {
        const missingToken = !inputToken ? (parsed.fromToken || 'SOL') : parsed.toToken;
        return {
          success: false,
          message: `❌ Token not found: ${missingToken}. Please check the token symbol and try again.`,
          confirmationRequired: false,
        };
      }
      
      // Calculate input amount in smallest units
      const inputAmountLamports = Math.floor(parsed.amount * Math.pow(10, inputToken.decimals));
      
      // Get Jupiter quote
      console.log("🔍 Getting Jupiter quote...");
      const quote = await getJupiterQuote(
        inputToken.mint,
        outputToken.mint,
        inputAmountLamports,
        500 // 5% slippage
      );
      
      if (!quote) {
        return {
          success: false,
          message: "❌ Unable to get price quote. The token pair might not have sufficient liquidity.",
          confirmationRequired: false,
        };
      }
      
      // Calculate output amount
      const outputAmount = Number(quote.outAmount) / Math.pow(10, outputToken.decimals);
      const priceImpact = parseFloat(quote.priceImpactPct || "0");
      
      // Store pending swap details
      pendingSwap = {
        inputMint: inputToken.mint,
        outputMint: outputToken.mint,
        inputAmount: parsed.amount,
        outputAmount,
        inputToken: inputToken.symbol,
        outputToken: outputToken.symbol,
        slippage: 5, // 5%
        quote,
      };
      
      // Create confirmation message
      const message = `
🔄 **TOKEN SWAP CONFIRMATION REQUIRED**

═══════════════════════════════════════════════════════════════

📋 **SWAP DETAILS**

   📤 **You're Swapping:**    ${parsed.amount} ${inputToken.symbol}
   📥 **You'll Receive:**     ~${formatNumber(outputAmount)} ${outputToken.symbol}
   
   💱 **Exchange Rate:**      1 ${inputToken.symbol} = ${formatNumber(outputAmount / parsed.amount)} ${outputToken.symbol}
   📊 **Price Impact:**       ${priceImpact.toFixed(4)}%
   ⚡ **Slippage Tolerance:** 5%

═══════════════════════════════════════════════════════════════

⚠️  **PLEASE REVIEW ALL DETAILS CAREFULLY BEFORE CONFIRMING**

🟢 **To CONFIRM this swap, type:**     \`confirm swap\` or \`yes swap\`
🔴 **To CANCEL this swap, type:**      \`cancel swap\` or \`no swap\`

═══════════════════════════════════════════════════════════════

💡 **Note:** Prices are estimates and may change due to market conditions. The actual amount received may vary within the slippage tolerance.
`.trim();
      
      return {
        success: true,
        message,
        swapDetails: {
          inputToken: inputToken.symbol,
          outputToken: outputToken.symbol,
          inputAmount: parsed.amount,
          outputAmount,
          priceImpact,
          slippage: 5,
        },
        confirmationRequired: true,
      };
      
    } catch (error: any) {
      console.error("❌ Error in swapTokens:", error);
      return {
        success: false,
        message: `❌ Error preparing swap: ${error.message}`,
        confirmationRequired: false,
      };
    }
  },
});

// Helper function to get pending swap (for confirmation tool)
export function getPendingSwap() {
  return pendingSwap;
}

// Helper function to clear pending swap
export function clearPendingSwap() {
  pendingSwap = null;
}

// Export the execute swap function for the confirmation tool
export { executeJupiterSwap };