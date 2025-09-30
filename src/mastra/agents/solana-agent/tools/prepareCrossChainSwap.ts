import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { fetchQuote } from "@mayanfinance/swap-sdk";
import { searchJupiterTokens, validateJupiterLiquidity } from "./jupiterUtils";

const RPC_URL = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";

// Helper function to get wallet from private key
function getWalletFromPrivateKey() {
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  
  if (!privateKey) {
    return null;
  }
  
  try {
    const secretKey = bs58.decode(privateKey);
    return { publicKey: new PublicKey(bs58.encode(secretKey.slice(32))) };
  } catch {
    try {
      const secretKey = new Uint8Array(JSON.parse(privateKey));
      return { publicKey: new PublicKey(bs58.encode(secretKey.slice(32))) };
    } catch {
      return null;
    }
  }
}

// Known token contract addresses for different chains
const KNOWN_TOKEN_CONTRACTS: Record<string, Record<string, string>> = {
  solana: {
    sol: "So11111111111111111111111111111111111111112",
    wsol: "So11111111111111111111111111111111111111112",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    bonk: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    jitosol: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  },
  ethereum: {
    eth: "0x0000000000000000000000000000000000000000", // Native ETH
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    usdt: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  },
  bsc: {
    bnb: "0x0000000000000000000000000000000000000000", // Native BNB
    usdc: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    usdt: "0x55d398326f99059ff775485246999027b3197955",
    wbnb: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  },
  polygon: {
    matic: "0x0000000000000000000000000000000000000000", // Native MATIC
    usdc: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    usdt: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    wmatic: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  },
  avalanche: {
    avax: "0x0000000000000000000000000000000000000000", // Native AVAX
    usdc: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    usdt: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
    wavax: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
  },
  arbitrum: {
    eth: "0x0000000000000000000000000000000000000000", // Native ETH
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Native USDC on Arbitrum
    usdt: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  },
  optimism: {
    eth: "0x0000000000000000000000000000000000000000", // Native ETH
    usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    usdt: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
    weth: "0x4200000000000000000000000000000000000006",
  },
  base: {
    eth: "0x0000000000000000000000000000000000000000", // Native ETH
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    weth: "0x4200000000000000000000000000000000000006",
  },
};

// Supported chains
const SUPPORTED_CHAINS = [
  "solana", "ethereum", "bsc", "polygon", "avalanche", "arbitrum", "optimism", "base"
];

// Global variable to store pending cross-chain swap
let pendingCrossChainSwap: {
  quote: any;
  fromToken: string;
  toToken: string;
  fromChain: string;
  toChain: string;
  amount: string;
  destinationAddress: string;
  slippageBps: string | number;
  gasDrop?: number;
} | null = null;

// Helper function to resolve token contract address
async function resolveTokenContract(tokenSymbol: string, chain: string): Promise<string | null> {
  console.log(`🔍 Resolving token contract for ${tokenSymbol} on ${chain}`);
  
  // Check known tokens first
  const knownContract = KNOWN_TOKEN_CONTRACTS[chain.toLowerCase()]?.[tokenSymbol.toLowerCase()];
  if (knownContract) {
    console.log(`✅ Found known token contract: ${knownContract}`);
    return knownContract;
  }
  
  // For Solana, use Jupiter search with liquidity validation
  if (chain.toLowerCase() === "solana") {
    try {
      const results = await searchJupiterTokens(tokenSymbol);
      if (results.length > 0) {
        // Validate liquidity for the found token
        const liquidityCheck = await validateJupiterLiquidity(results[0].address);
        
        if (liquidityCheck.isValid && liquidityCheck.liquidityUSD > 0) {
          console.log(`✅ Found Solana token via Jupiter: ${results[0].address} (Liquidity: $${liquidityCheck.liquidityUSD})`);
          return results[0].address;
        } else {
          console.log(`❌ Token found but insufficient liquidity: ${results[0].address} (${liquidityCheck.error || 'No liquidity'})`);
          // Try other results if available
          for (let i = 1; i < Math.min(results.length, 3); i++) {
            const altCheck = await validateJupiterLiquidity(results[i].address);
            if (altCheck.isValid && altCheck.liquidityUSD > 0) {
              console.log(`✅ Alternative token found: ${results[i].address} (Liquidity: $${altCheck.liquidityUSD})`);
              return results[i].address;
            }
          }
        }
      }
    } catch (error) {
      console.log(`❌ Error searching Solana token: ${error}`);
    }
  }
  
  // If it looks like an address, return as-is
  if (tokenSymbol.length > 20 && (tokenSymbol.startsWith("0x") || tokenSymbol.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/))) {
    console.log(`✅ Using provided address: ${tokenSymbol}`);
    return tokenSymbol;
  }
  
  console.log(`❌ Token contract not found for ${tokenSymbol} on ${chain}`);
  return null;
}

// Helper function to parse cross-chain swap command
function parseCrossChainSwapCommand(input: string): {
  amount: string;
  fromToken: string;
  fromChain: string;
  toToken: string;
  toChain: string;
  destinationAddress?: string;
} | null {
  console.log("🔍 Parsing cross-chain swap command:", input);
  
  const normalizedInput = input.toLowerCase().trim();
  
  // Pattern: "bridge X TOKEN from CHAIN1 to CHAIN2"
  const bridgePattern = /bridge\s+(\d+(?:\.\d+)?)\s+([a-zA-Z0-9]+)\s+from\s+([a-zA-Z]+)\s+to\s+([a-zA-Z]+)/i;
  const bridgeMatch = normalizedInput.match(bridgePattern);
  if (bridgeMatch) {
    return {
      amount: bridgeMatch[1],
      fromToken: bridgeMatch[2],
      fromChain: bridgeMatch[3],
      toToken: bridgeMatch[2], // Same token
      toChain: bridgeMatch[4],
    };
  }
  
  // Pattern: "swap X TOKEN1 from CHAIN1 to TOKEN2 on CHAIN2"
  const swapPattern = /swap\s+(\d+(?:\.\d+)?)\s+([a-zA-Z0-9]+)\s+from\s+([a-zA-Z]+)\s+to\s+([a-zA-Z0-9]+)\s+on\s+([a-zA-Z]+)/i;
  const swapMatch = normalizedInput.match(swapPattern);
  if (swapMatch) {
    return {
      amount: swapMatch[1],
      fromToken: swapMatch[2],
      fromChain: swapMatch[3],
      toToken: swapMatch[4],
      toChain: swapMatch[5],
    };
  }
  
  // Pattern: "transfer X TOKEN from CHAIN1 to CHAIN2"
  const transferPattern = /transfer\s+(\d+(?:\.\d+)?)\s+([a-zA-Z0-9]+)\s+from\s+([a-zA-Z]+)\s+to\s+([a-zA-Z]+)/i;
  const transferMatch = normalizedInput.match(transferPattern);
  if (transferMatch) {
    return {
      amount: transferMatch[1],
      fromToken: transferMatch[2],
      fromChain: transferMatch[3],
      toToken: transferMatch[2], // Same token
      toChain: transferMatch[4],
    };
  }
  
  console.log("❌ No cross-chain swap pattern matched");
  return null;
}

// Helper function to format numbers
function formatNumber(num: number, decimals: number = 6): string {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(decimals);
}

export const prepareCrossChainSwap = createTool({
  id: "prepareCrossChainSwap",
  description: "Prepare a cross-chain token swap using Mayan Finance. Supports bridging tokens FROM Solana TO EVM chains. You only need a Solana wallet - the destination address is where you want to receive tokens on the target chain.",
  inputSchema: z.object({
    command: z.string().describe("Cross-chain swap command like 'bridge 1 USDC from solana to ethereum' or 'swap 0.1 SOL from solana to USDC on ethereum'"),
    destinationAddress: z.string().optional().describe("Destination wallet address on the target chain"),
    // IMPORTANT: Gemini function declarations do not support JSON Schema unions (type: ["number","string"]).
    // Use a string here and parse to number/'auto' inside execute to avoid invalid payloads.
    slippageBps: z.string().optional().describe("Slippage in basis points as a string (e.g., '500') or 'auto'"),
    gasDrop: z.number().optional().describe("Amount of native token to receive on destination chain"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    swapDetails: z.object({
      fromToken: z.string(),
      toToken: z.string(),
      fromChain: z.string(),
      toChain: z.string(),
      amount: z.string(),
      estimatedOutput: z.string(),
      priceImpact: z.string(),
      slippage: z.string(),
      gasDrop: z.string().optional(),
    }).optional(),
    confirmationRequired: z.boolean(),
  }),
  execute: async (args: any) => {
    const command = 
      args.command || 
      args.input?.command || 
      args.context?.command ||
      (typeof args === "string" ? args : "") ||
      "";
    
    const destinationAddress = 
      args.destinationAddress || 
      args.input?.destinationAddress || 
      args.context?.destinationAddress ||
      "";
    
    // Safely parse slippageBps from string (Gemini-friendly schema). Accepts numeric strings or 'auto'.
    const slippageRaw = args.slippageBps || args.input?.slippageBps || "auto";
    let slippageBps: string | number = "auto";
    if (typeof slippageRaw === "number") {
      slippageBps = slippageRaw;
    } else if (typeof slippageRaw === "string") {
      const trimmed = slippageRaw.trim().toLowerCase();
      if (trimmed === "auto") {
        slippageBps = "auto";
      } else if (!isNaN(Number(trimmed))) {
        slippageBps = Number(trimmed);
      } else {
        // Fallback: keep as 'auto' if not parseable
        slippageBps = "auto";
      }
    }
    const gasDrop = args.gasDrop || args.input?.gasDrop;
    
    console.log("🚀 prepareCrossChainSwap called with command:", command);
    
    // Parse the command
    const parsed = parseCrossChainSwapCommand(command);
    if (!parsed) {
      return {
        success: false,
        message: `❌ Invalid cross-chain swap command format. Please use one of these formats:

• **Bridge same token:** "bridge 1 USDC from solana to ethereum"
• **Swap different tokens:** "swap 0.1 SOL from solana to USDC on ethereum"
• **Transfer tokens:** "transfer 100 USDT from solana to ethereum"

**Supported source chain:** solana
**Supported destination chains:** ${SUPPORTED_CHAINS.filter(c => c !== 'solana').join(", ")}

**Examples:**
- bridge 10 USDC from solana to ethereum [destination_address]
- swap 0.5 SOL from solana to USDC on arbitrum [destination_address]
- transfer 50 USDT from solana to arbitrum [destination_address]

**Note:** You only need a Solana wallet. The destination address is where you want to receive tokens on the target chain.`,
        confirmationRequired: false,
      };
    }
    
    // Validate chains
    if (!SUPPORTED_CHAINS.includes(parsed.fromChain.toLowerCase()) || 
        !SUPPORTED_CHAINS.includes(parsed.toChain.toLowerCase())) {
      return {
        success: false,
        message: `❌ Unsupported chain. Supported chains: ${SUPPORTED_CHAINS.join(", ")}`,
        confirmationRequired: false,
      };
    }
    
    // Require destination address
    if (!destinationAddress) {
      return {
        success: false,
        message: `❌ Destination address is required for cross-chain swaps. Please provide the wallet address on ${parsed.toChain} where you want to receive the tokens.

**Example:** "bridge 1 USDC from solana to ethereum" with destination address "0x1234..."`,
        confirmationRequired: false,
      };
    }
    
    // Safety check - maximum swap limit
    if (parseFloat(parsed.amount) > 100) {
      return {
        success: false,
        message: "❌ Swap amount exceeds safety limit of 100 tokens. For larger amounts, please contact the administrator.",
        confirmationRequired: false,
      };
    }
    
    // Check wallet balance for Solana swaps
    if (parsed.fromChain.toLowerCase() === "solana") {
      const wallet = getWalletFromPrivateKey();
      if (!wallet) {
        return {
          success: false,
          message: "❌ Solana wallet not configured. Please set WALLET_PRIVATE_KEY in your environment variables.",
          confirmationRequired: false,
        };
      }
      
      try {
        const connection = new Connection(RPC_URL);
        const balance = await connection.getBalance(wallet.publicKey);
        const balanceInSol = balance / LAMPORTS_PER_SOL;
        
        console.log(`💰 Wallet address: ${wallet.publicKey.toString()}`);
        console.log(`💰 Wallet balance: ${balanceInSol} SOL ($${(balanceInSol * 150).toFixed(2)} USD estimate)`);
        
        // For SOL swaps, check if we have enough SOL
        if (parsed.fromToken.toLowerCase() === 'sol') {
          const swapAmount = parseFloat(parsed.amount);
          const estimatedFees = 0.06; // Increased fees for cross-chain swaps with higher slippage
          const requiredAmount = swapAmount + estimatedFees;
          
          console.log(`💸 Swap amount: ${swapAmount} SOL`);
          console.log(`⚡ Estimated fees: ${estimatedFees} SOL`);
          console.log(`📊 Total required: ${requiredAmount} SOL`);
          console.log(`✅ Available: ${balanceInSol} SOL`);
          console.log(`🔍 Sufficient funds: ${balanceInSol >= requiredAmount ? 'YES' : 'NO'}`);
          
          if (balanceInSol < requiredAmount) {
            return {
              success: false,
              message: `❌ Insufficient SOL balance for cross-chain swap.

**Current Balance:** ${balanceInSol.toFixed(6)} SOL (~$${(balanceInSol * 150).toFixed(2)} USD)
**Swap Amount:** ${swapAmount} SOL
**Estimated Fees:** ${estimatedFees} SOL (cross-chain bridge + Jupiter swap fees)
**Total Required:** ${requiredAmount.toFixed(6)} SOL
**Shortfall:** ${(requiredAmount - balanceInSol).toFixed(6)} SOL

Cross-chain swaps require additional fees for:
- Jupiter swap on Solana (~0.005 SOL)
- Cross-chain bridge fees (~0.01-0.015 SOL)
- Higher slippage tolerance (~0.02-0.04 SOL additional cost)
- Transaction fees (~0.000005 SOL per transaction)

Please add more SOL to your wallet or try a smaller amount.`,
              confirmationRequired: false,
            };
          }
        } else {
          // For other tokens, ensure we have at least 0.02 SOL for fees
          const requiredFees = 0.06;
          console.log(`💰 Wallet balance: ${balanceInSol} SOL`);
          console.log(`⚡ Required fees: ${requiredFees} SOL`);
          console.log(`🔍 Sufficient for fees: ${balanceInSol >= requiredFees ? 'YES' : 'NO'}`);
          
          if (balanceInSol < requiredFees) {
            return {
              success: false,
              message: `❌ Insufficient SOL for cross-chain swap fees.

**Current Balance:** ${balanceInSol.toFixed(6)} SOL (~$${(balanceInSol * 150).toFixed(2)} USD)
**Required for Fees:** ${requiredFees} SOL
**Shortfall:** ${(requiredFees - balanceInSol).toFixed(6)} SOL

Cross-chain swaps require SOL for transaction fees even when swapping other tokens.`,
              confirmationRequired: false,
            };
          }
        }
      } catch (error) {
        console.error("Error checking wallet balance:", error);
        return {
          success: false,
          message: "❌ Unable to check wallet balance. Please try again.",
          confirmationRequired: false,
        };
      }
    }
    
    try {
      // Resolve token contracts
      const fromTokenContract = await resolveTokenContract(parsed.fromToken, parsed.fromChain);
      const toTokenContract = await resolveTokenContract(parsed.toToken, parsed.toChain);
      
      if (!fromTokenContract || !toTokenContract) {
        const missingToken = !fromTokenContract ? 
          `${parsed.fromToken} on ${parsed.fromChain}` : 
          `${parsed.toToken} on ${parsed.toChain}`;
        return {
          success: false,
          message: `❌ Token contract not found: ${missingToken}. Please check the token symbol and chain.`,
          confirmationRequired: false,
        };
      }
      
      // Convert amount to smallest units (assuming 6 decimals for most tokens, 9 for SOL)
      const decimals = parsed.fromToken.toLowerCase() === 'sol' ? 9 : 6;
      const amountIn64 = (parseFloat(parsed.amount) * Math.pow(10, decimals)).toString();
      
      console.log("🔍 Fetching Mayan quote...");
      console.log("🔧 BEFORE fetchQuote - slippageBps value:", slippageBps);
      console.log("🔧 BEFORE fetchQuote - slippageBps type:", typeof slippageBps);
      
      // Use higher slippage for cross-chain swaps to avoid Jupiter failures
      const adjustedSlippageBps = 1000; // 10% slippage for cross-chain swaps
      
      console.log("Quote params:", {
        amountIn64,
        fromToken: fromTokenContract,
        toToken: toTokenContract,
        fromChain: parsed.fromChain,
        toChain: parsed.toChain,
        slippageBps: adjustedSlippageBps,
        gasDrop,
      });
      
      // Fetch quote from Mayan
      const quotes = await fetchQuote({
        amountIn64,
        fromToken: fromTokenContract,
        toToken: toTokenContract,
        fromChain: parsed.fromChain,
        toChain: parsed.toChain,
        slippageBps: adjustedSlippageBps, // Higher slippage for cross-chain
        gasDrop,
      });
      
      console.log("📊 Quote response received:");
      console.log("- Number of quotes:", quotes?.length || 0);
      if (quotes && quotes.length > 0) {
        console.log("- Best quote details:", {
          expectedAmountOut: quotes[0].expectedAmountOut,
          priceImpact: quotes[0].priceImpact,
          feeAmount: quotes[0].feeAmount,
          bridgeFee: quotes[0].bridgeFee,
          relayerFee: quotes[0].relayerFee,
        });
      }
      
      if (!quotes || quotes.length === 0) {
        return {
          success: false,
          message: `❌ No route available for this cross-chain swap. This could be due to:

• **Insufficient liquidity** for the ${parsed.fromToken}→${parsed.toToken} pair
• **Network congestion** affecting Jupiter routing
• **Temporary bridge maintenance** between ${parsed.fromChain} and ${parsed.toChain}

**Suggestions:**
- Try a smaller amount (e.g., 0.01-0.02 SOL)
- Use more common tokens like USDC or USDT
- Wait a few minutes and try again
- Check if the destination chain is experiencing issues`,
          confirmationRequired: false,
        };
      }
      
      const quote = quotes[0]; // Use the best quote
      
      // CRITICAL FIX: Mayan's expectedAmountOut is already in human-readable format
      // Do NOT divide by decimals again
      const estimatedOutput = parseFloat(quote.expectedAmountOut);
      
      // Extract fee information (these are also in human-readable format from Mayan)
      const feeAmount = quote.feeAmount ? parseFloat(quote.feeAmount) : 0;
      const bridgeFee = quote.bridgeFee ? parseFloat(quote.bridgeFee) : 0;
      const relayerFee = quote.relayerFee ? parseFloat(quote.relayerFee) : 0;
      
      // Calculate exchange rate correctly
      const exchangeRate = estimatedOutput / parseFloat(parsed.amount);
      
      console.log("🔍 Debug calculation:");
      console.log("- expectedAmountOut (raw):", quote.expectedAmountOut);
      console.log("- estimatedOutput (formatted):", estimatedOutput);
      console.log("- input amount:", parsed.amount);
      console.log("- calculated exchange rate:", exchangeRate);
      console.log("- quote.price from Mayan:", quote.price);
      
      // Store pending swap details
      pendingCrossChainSwap = {
        quote,
        fromToken: parsed.fromToken.toUpperCase(),
        toToken: parsed.toToken.toUpperCase(),
        fromChain: parsed.fromChain,
        toChain: parsed.toChain,
        amount: parsed.amount,
        destinationAddress,
        slippageBps,
        gasDrop,
      };
      
      // Create confirmation message
      const message = `
🌉 **CROSS-CHAIN SWAP CONFIRMATION REQUIRED**

═══════════════════════════════════════════════════════════════

📋 **SWAP DETAILS**

   📤 **From:**              ${parsed.amount} ${parsed.fromToken.toUpperCase()} on ${parsed.fromChain}
   📥 **To:**                ~${formatNumber(estimatedOutput)} ${parsed.toToken.toUpperCase()} on ${parsed.toChain}
   🎯 **Destination:**       ${destinationAddress}
   
   💱 **Exchange Rate:**     1 ${parsed.fromToken.toUpperCase()} = ${formatNumber(exchangeRate)} ${parsed.toToken.toUpperCase()}
   ⚡ **Slippage:**          ${(adjustedSlippageBps / 100).toFixed(1)}% (High for cross-chain stability)
   ${gasDrop ? `🔥 **Gas Drop:**         ${gasDrop} native tokens on ${parsed.toChain}` : ''}

═══════════════════════════════════════════════════════════════

💰 **FEE BREAKDOWN**

   ${feeAmount > 0 ? `🏦 **Protocol Fee:**      ${formatNumber(feeAmount)} ${parsed.toToken.toUpperCase()}` : '🏦 **Protocol Fee:**      Included in quote'}
   ${bridgeFee > 0 ? `🌉 **Bridge Fee:**        ${formatNumber(bridgeFee)} ${parsed.fromToken.toUpperCase()}` : '🌉 **Bridge Fee:**        Included in quote'}
   ${relayerFee > 0 ? `⚡ **Relayer Fee:**       ${formatNumber(relayerFee)} ${parsed.toToken.toUpperCase()}` : '⚡ **Relayer Fee:**       Included in quote'}
   📊 **Price Impact:**     ${quote.priceImpact ? (parseFloat(quote.priceImpact) * 100).toFixed(4) + '%' : 'Minimal'}

═══════════════════════════════════════════════════════════════

⚠️  **PLEASE REVIEW ALL DETAILS CAREFULLY BEFORE CONFIRMING**

🟢 **To CONFIRM this cross-chain swap, type:**  \`confirm cross-chain swap\`
🔴 **To CANCEL this cross-chain swap, type:**   \`cancel cross-chain swap\`

═══════════════════════════════════════════════════════════════

💡 **Note:** Cross-chain swaps may take several minutes to complete. You can track progress on Mayan Explorer.
`.trim();
      
      return {
        success: true,
        message,
        swapDetails: {
          fromToken: parsed.fromToken.toUpperCase(),
          toToken: parsed.toToken.toUpperCase(),
          fromChain: parsed.fromChain,
          toChain: parsed.toChain,
          amount: parsed.amount,
          estimatedOutput: formatNumber(estimatedOutput),
          priceImpact: quote.priceImpact ? (parseFloat(quote.priceImpact) * 100).toFixed(4) + '%' : 'Minimal',
          slippage: typeof slippageBps === 'number' ? (slippageBps / 100).toFixed(2) + '%' : slippageBps,
          gasDrop: gasDrop ? `${gasDrop} native tokens` : undefined,
        },
        confirmationRequired: true,
      };
      
    } catch (error: any) {
      console.error("❌ Error in prepareCrossChainSwap:", error);
      return {
        success: false,
        message: `❌ Error preparing cross-chain swap: ${error.message || 'Unknown error occurred'}`,
        confirmationRequired: false,
      };
    }
  },
});

// Helper function to get pending cross-chain swap (for confirmation tool)
export function getPendingCrossChainSwap() {
  return pendingCrossChainSwap;
}

// Helper function to clear pending cross-chain swap
export function clearPendingCrossChainSwap() {
  pendingCrossChainSwap = null;
}