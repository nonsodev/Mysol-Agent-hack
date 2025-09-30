import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { getPendingSwap, clearPendingSwap, executeJupiterSwap } from "./swapTokens";

const RPC_URL = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";

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

// Helper function to parse confirmation response
function parseConfirmationResponse(input: string): 'confirm' | 'cancel' | 'invalid' {
  const normalizedInput = input.toLowerCase().trim();
  
  if (normalizedInput === "confirm swap" || normalizedInput === "yes swap" || normalizedInput.includes("confirm") && normalizedInput.includes("swap")) {
    return 'confirm';
  }
  
  if (normalizedInput === "cancel swap" || normalizedInput === "no swap" || normalizedInput.includes("cancel") && normalizedInput.includes("swap")) {
    return 'cancel';
  }
  
  return 'invalid';
}

// Helper function to format numbers
function formatNumber(num: number, decimals: number = 6): string {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(decimals);
}

export const confirmSwap = createTool({
  id: "confirmSwap",
  description: "Confirm and execute a pending token swap. This tool actually executes the swap on Jupiter Exchange after user confirmation.",
  inputSchema: z.object({
    confirmation: z.string().describe("User confirmation response: 'yes', 'y', 'no', 'n', 'confirm', or 'cancel'"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    transactionHash: z.string().optional(),
    solscanUrl: z.string().optional(),
    swapDetails: z.object({
      inputToken: z.string(),
      outputToken: z.string(),
      inputAmount: z.number(),
      outputAmount: z.number(),
      actualOutputAmount: z.number(),
      priceImpact: z.number(),
      slippage: z.number(),
    }).optional(),
  }),
  execute: async (args) => {
    const confirmation = 
      args.confirmation || 
      args.input?.confirmation || 
      args.context?.confirmation ||
      (typeof args === "string" ? args : "") ||
      "";
    
    console.log("🚀 confirmSwap called with confirmation:", confirmation);
    
    // Parse the confirmation response
    const response = parseConfirmationResponse(confirmation);
    
    if (response === 'invalid') {
      return {
        success: false,
        message: `❌ Invalid response. Please type "confirm swap" or "cancel swap" to proceed.\n\nReceived: "${confirmation}"`,
      };
    }
    
    if (response === 'cancel') {
      // Clear pending swap and cancel
      clearPendingSwap();
      return {
        success: false,
        message: "🚫 **SWAP CANCELLED**\n\nThe token swap has been cancelled. No transaction was executed.",
      };
    }
    
    // User confirmed - proceed with swap
    const pendingSwap = getPendingSwap();
    if (!pendingSwap) {
      return {
        success: false,
        message: "❌ No pending swap found. Please initiate a swap first using commands like 'buy 0.01 SOL of BONK'.",
      };
    }
    
    // Check if wallet is configured
    const wallet = getWalletFromPrivateKey();
    if (!wallet) {
      clearPendingSwap();
      return {
        success: false,
        message: "❌ Wallet not configured. Please set WALLET_PRIVATE_KEY in your environment variables.",
      };
    }
    
    try {
      console.log("🔄 Executing Jupiter swap...");
      const signature = await executeJupiterSwap(pendingSwap.quote, wallet);
      
      // Get the actual output amount from the transaction
      const connection = new Connection(RPC_URL);
      await connection.confirmTransaction(signature, 'confirmed');
      
      // Calculate actual output amount (this is an approximation)
      const actualOutputAmount = pendingSwap.outputAmount; // In a real implementation, you'd parse the transaction logs
      
      const solscanUrl = `https://solscan.io/tx/${signature}`;
      
      const message = `
✅ **SWAP EXECUTED SUCCESSFULLY!**

═══════════════════════════════════════════════════════════════

🎉 **SWAP COMPLETED**

   🔄 **Swapped:**           ${pendingSwap.inputAmount} ${pendingSwap.inputToken}
   📥 **Received:**          ~${formatNumber(actualOutputAmount)} ${pendingSwap.outputToken}
   
   💱 **Exchange Rate:**     1 ${pendingSwap.inputToken} = ${formatNumber(pendingSwap.outputAmount / pendingSwap.inputAmount)} ${pendingSwap.outputToken}
   📊 **Price Impact:**      ${((pendingSwap.quote.priceImpactPct || 0) * 100).toFixed(4)}%
   ⚡ **Slippage Used:**     ${pendingSwap.slippage}%

═══════════════════════════════════════════════════════════════

🔗 **TRANSACTION DETAILS**

   🆔 **Transaction Hash:**  ${signature}
   🌐 **View on Solscan:**   ${solscanUrl}

═══════════════════════════════════════════════════════════════

🚀 **Your token swap has been successfully executed on Jupiter Exchange!**
`.trim();
      
      // Clear the pending swap
      clearPendingSwap();
      
      return {
        success: true,
        message,
        transactionHash: signature,
        solscanUrl,
        swapDetails: {
          inputToken: pendingSwap.inputToken,
          outputToken: pendingSwap.outputToken,
          inputAmount: pendingSwap.inputAmount,
          outputAmount: pendingSwap.outputAmount,
          actualOutputAmount,
          priceImpact: (pendingSwap.quote.priceImpactPct || 0) * 100,
          slippage: pendingSwap.slippage,
        },
      };
      
    } catch (error: any) {
      console.error("❌ Swap execution failed:", error);
      
      // Clear the pending swap on error
      clearPendingSwap();
      
      let errorMessage = "❌ Token swap failed: ";
      
      if (error.message?.includes("insufficient funds")) {
        errorMessage += "Insufficient funds for swap and transaction fees.";
      } else if (error.message?.includes("slippage")) {
        errorMessage += "Price moved beyond slippage tolerance. Try increasing slippage or try again.";
      } else if (error.message?.includes("liquidity")) {
        errorMessage += "Insufficient liquidity for this swap amount.";
      } else if (error.message?.includes("timeout")) {
        errorMessage += "Transaction timed out. Network may be congested, please try again.";
      } else if (error.message?.includes("blockhash")) {
        errorMessage += "Network congestion. Please try again in a moment.";
      } else {
        errorMessage += error.message || "Unknown error occurred during swap execution.";
      }
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  },
});