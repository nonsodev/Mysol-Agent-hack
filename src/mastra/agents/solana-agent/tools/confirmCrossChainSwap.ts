import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { swapFromSolana, swapFromEvm } from "@mayanfinance/swap-sdk";
import { ethers } from "ethers";
import { getPendingCrossChainSwap, clearPendingCrossChainSwap } from "./prepareCrossChainSwap";

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
  
  // More strict matching for confirmation
  if (normalizedInput === "confirm cross-chain swap" || 
      normalizedInput === "confirm crosschain swap" ||
      normalizedInput === "confirm cross chain swap" ||
      normalizedInput === "yes cross-chain swap" || 
      normalizedInput === "yes crosschain swap" ||
      normalizedInput === "confirm swap" ||
      (normalizedInput.includes("confirm") && normalizedInput.includes("cross") && normalizedInput.includes("chain")) ||
      (normalizedInput.includes("confirm") && normalizedInput.includes("crosschain")) ||
      (normalizedInput.includes("yes") && normalizedInput.includes("cross") && normalizedInput.includes("chain"))) {
    return 'confirm';
  }
  
  if (normalizedInput === "cancel cross-chain swap" || 
      normalizedInput === "cancel crosschain swap" ||
      normalizedInput === "cancel cross chain swap" ||
      normalizedInput === "no cross-chain swap" || 
      normalizedInput === "no crosschain swap" ||
      normalizedInput === "cancel swap" ||
      (normalizedInput.includes("cancel") && normalizedInput.includes("cross") && normalizedInput.includes("chain")) ||
      (normalizedInput.includes("cancel") && normalizedInput.includes("crosschain")) ||
      (normalizedInput.includes("no") && normalizedInput.includes("cross") && normalizedInput.includes("chain"))) {
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

export const confirmCrossChainSwap = createTool({
  id: "confirmCrossChainSwap",
  description: "Confirm and execute a pending cross-chain token swap using Mayan Finance. This tool actually executes the cross-chain swap after user confirmation.",
  inputSchema: z.object({
    confirmation: z.string().describe("User confirmation response: 'confirm cross-chain swap' or 'cancel cross-chain swap'"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    transactionHash: z.string().optional(),
    explorerUrl: z.string().optional(),
    swapDetails: z.object({
      fromToken: z.string(),
      toToken: z.string(),
      fromChain: z.string(),
      toChain: z.string(),
      amount: z.string(),
      destinationAddress: z.string(),
    }).optional(),
  }),
  execute: async (args) => {
    const confirmation = 
      args.confirmation || 
      args.input?.confirmation || 
      args.context?.confirmation ||
      (typeof args === "string" ? args : "") ||
      "";
    
    console.log("🚀 confirmCrossChainSwap called with confirmation:", confirmation);
    
    // Parse the confirmation response
    const response = parseConfirmationResponse(confirmation);
    
    if (response === 'invalid') {
      return {
        success: false,
        message: `❌ Invalid response. Please type "confirm cross-chain swap" or "cancel cross-chain swap" to proceed.\n\nReceived: "${confirmation}"`,
      };
    }
    
    if (response === 'cancel') {
      // Clear pending swap and cancel
      clearPendingCrossChainSwap();
      return {
        success: false,
        message: "🚫 **CROSS-CHAIN SWAP CANCELLED**\n\nThe cross-chain token swap has been cancelled. No transaction was executed.",
      };
    }
    
    // User confirmed - proceed with swap
    const pendingSwap = getPendingCrossChainSwap();
    if (!pendingSwap) {
      return {
        success: false,
        message: "❌ No pending cross-chain swap found. Please initiate a cross-chain swap first using commands like 'bridge 1 USDC from solana to ethereum'.",
      };
    }
    
    try {
      let transactionHash: string;
      let explorerUrl: string;
      
      // Execute swap based on source chain
      if (pendingSwap.fromChain.toLowerCase() === "solana") {
        // Swap from Solana
        const wallet = getWalletFromPrivateKey();
        if (!wallet) {
          clearPendingCrossChainSwap();
          return {
            success: false,
            message: "❌ Solana wallet not configured. Please set WALLET_PRIVATE_KEY in your environment variables.",
          };
        }
        
        // Final balance check before execution
        const connection = new Connection(RPC_URL);
        const balance = await connection.getBalance(wallet.publicKey);
        const balanceInSol = balance / LAMPORTS_PER_SOL;
        const swapAmount = parseFloat(pendingSwap.amount);
        const estimatedFees = 0.06;
        const totalRequired = swapAmount + estimatedFees;
        
        console.log(`🔍 Final balance check before execution:`);
        console.log(`💰 Wallet: ${wallet.publicKey.toString()}`);
        console.log(`💰 Balance: ${balanceInSol} SOL`);
        console.log(`💸 Swap amount: ${swapAmount} SOL`);
        console.log(`⚡ Estimated fees: ${estimatedFees} SOL`);
        console.log(`📊 Total required: ${totalRequired} SOL`);
        console.log(`✅ Sufficient: ${balanceInSol >= totalRequired ? 'YES' : 'NO'}`);
        
        // Additional detailed logging
        console.log(`🔧 DETAILED BALANCE INFO:`);
        console.log(`- Balance in lamports: ${balance}`);
        console.log(`- Balance in SOL (precise): ${balance / LAMPORTS_PER_SOL}`);
        console.log(`- Swap amount in lamports: ${swapAmount * LAMPORTS_PER_SOL}`);
        console.log(`- Estimated fees in lamports: ${estimatedFees * LAMPORTS_PER_SOL}`);
        console.log(`- Total required in lamports: ${totalRequired * LAMPORTS_PER_SOL}`);
        console.log(`- Available after swap: ${(balanceInSol - totalRequired).toFixed(9)} SOL`);
        
        // Log the pending swap details
        console.log(`🔧 PENDING SWAP DETAILS:`);
        console.log(`- Quote object keys:`, Object.keys(pendingSwap.quote));
        console.log(`- Quote expectedAmountOut:`, pendingSwap.quote.expectedAmountOut);
        console.log(`- Quote priceImpact:`, pendingSwap.quote.priceImpact);
        console.log(`- Quote feeAmount:`, pendingSwap.quote.feeAmount);
        console.log(`- Quote bridgeFee:`, pendingSwap.quote.bridgeFee);
        console.log(`- Quote relayerFee:`, pendingSwap.quote.relayerFee);
        
        if (balanceInSol < totalRequired) {
          clearPendingCrossChainSwap();
          return {
            success: false,
            message: `❌ Insufficient funds detected during final check.

**Balance:** ${balanceInSol.toFixed(6)} SOL
**Required:** ${totalRequired.toFixed(6)} SOL
**Shortfall:** ${(totalRequired - balanceInSol).toFixed(6)} SOL

Please add more SOL to your wallet and try again.`,
          };
        }
        
        // Create sign transaction callback
        const signSolanaTransaction = async (tx: Transaction): Promise<Transaction> => {
          console.log(`🔧 SIGNING TRANSACTION:`);
          console.log(`- Transaction instructions count:`, tx.instructions?.length || 0);
          console.log(`- Recent blockhash:`, tx.recentBlockhash);
          console.log(`- Fee payer:`, tx.feePayer?.toString());
          
          // Log each instruction
          if (tx.instructions && tx.instructions.length > 0) {
            tx.instructions.forEach((instruction, index) => {
              console.log(`- Instruction ${index + 1}:`, {
                programId: instruction.programId.toString(),
                keys: instruction.keys?.length || 0,
                dataLength: instruction.data?.length || 0,
              });
            });
          } else {
            console.log(`- No instructions found in transaction`);
          }
          
          tx.sign([wallet]); // Pass wallet as array
          console.log(`✅ Transaction signed successfully`);
          return tx;
        };
        
        console.log("🔄 Executing cross-chain swap from Solana...");
        console.log(`🔧 CALLING swapFromSolana with:`);
        console.log(`- Quote type:`, typeof pendingSwap.quote);
        console.log(`- Wallet public key:`, wallet.publicKey.toString());
        console.log(`- Destination address:`, pendingSwap.destinationAddress);
        console.log(`- Connection endpoint:`, RPC_URL);
        
        const result = await swapFromSolana(
          pendingSwap.quote,
          wallet.publicKey.toString(),
          pendingSwap.destinationAddress,
          undefined, // referrerAddresses (optional)
          signSolanaTransaction,
          connection
        );
        
        console.log(`✅ swapFromSolana completed successfully:`, result);
        transactionHash = result;
        explorerUrl = `https://explorer.mayan.finance/swap/${transactionHash}`;
        
      } else {
        // EVM chains not supported in this implementation
        clearPendingCrossChainSwap();
        return {
          success: false,
          message: `❌ Cross-chain swaps from EVM chains (${pendingSwap.fromChain}) are not currently supported. This tool only supports swaps FROM Solana TO other chains. The destination address you provided will receive the tokens on ${pendingSwap.toChain}.`,
        };
      }
      
      // Calculate estimated output for display
      const outputDecimals = pendingSwap.toToken.toLowerCase() === 'sol' ? 9 : 6;
      const estimatedOutput = parseFloat(pendingSwap.quote.expectedAmountOut) / Math.pow(10, outputDecimals);
      
      const message = `
✅ **CROSS-CHAIN SWAP EXECUTED SUCCESSFULLY!**

═══════════════════════════════════════════════════════════════

🎉 **SWAP COMPLETED**

   🌉 **Bridged:**           ${pendingSwap.amount} ${pendingSwap.fromToken} (${pendingSwap.fromChain})
   📥 **Receiving:**         ~${formatNumber(estimatedOutput)} ${pendingSwap.toToken} (${pendingSwap.toChain})
   🎯 **Destination:**       ${pendingSwap.destinationAddress}

═══════════════════════════════════════════════════════════════

🔗 **TRANSACTION DETAILS**

   🆔 **Transaction Hash:**  ${transactionHash}
   🌐 **Track on Mayan:**    ${explorerUrl}

═══════════════════════════════════════════════════════════════

⏳ **Important:** Cross-chain swaps may take several minutes to complete. 
Use the Mayan Explorer link above to track the progress of your swap.

🚀 **Your cross-chain swap has been successfully initiated!**
`.trim();
      
      // Clear the pending swap
      clearPendingCrossChainSwap();
      
      return {
        success: true,
        message,
        transactionHash,
        explorerUrl,
        swapDetails: {
          fromToken: pendingSwap.fromToken,
          toToken: pendingSwap.toToken,
          fromChain: pendingSwap.fromChain,
          toChain: pendingSwap.toChain,
          amount: pendingSwap.amount,
          destinationAddress: pendingSwap.destinationAddress,
        },
      };
      
    } catch (error: any) {
      console.error("❌ Cross-chain swap execution failed:", error);
      
      // Clear the pending swap on error
      clearPendingCrossChainSwap();
      
      let errorMessage = "❌ Cross-chain swap failed: ";
      
      if (error.message?.includes("insufficient funds")) {
        errorMessage += "Insufficient funds for swap and transaction fees. Please check your wallet balance and ensure you have enough SOL for fees.";
      } else if (error.message?.includes("slippage")) {
        errorMessage += "Price moved beyond slippage tolerance. Try increasing slippage or try again.";
      } else if (error.message?.includes("liquidity")) {
        errorMessage += "Insufficient liquidity for this cross-chain swap.";
      } else if (error.message?.includes("timeout")) {
        errorMessage += "Transaction timed out. Network may be congested, please try again.";
      } else if (error.message?.includes("allowance")) {
        errorMessage += "Insufficient token allowance. Please approve the token for spending first.";
      } else if (error.message?.includes("network")) {
        errorMessage += "Network error. Please check your connection and try again.";
      } else if (error.message?.includes("Failed to send transaction")) {
        errorMessage += "Transaction failed to broadcast. This is often due to Jupiter routing issues, insufficient liquidity, or slippage tolerance. Try a smaller amount or wait a few minutes and retry.";
      } else {
        errorMessage += error.message || "Unknown error occurred during cross-chain swap execution.";
      }
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  },
});