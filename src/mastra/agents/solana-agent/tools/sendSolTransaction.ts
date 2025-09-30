import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { setPendingTransaction } from "./confirmTransaction";

const RPC_URL = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";

// Helper function to extract SOL amount and recipient address from user input
function parseTransactionCommand(input: string): { amount: number; recipient: string } | null {
  console.log("🔍 Parsing transaction command:", input);

  const patterns = [
    /send\s+(\d+(?:\.\d+)?)\s+sol\s+to\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i,
    /transfer\s+(\d+(?:\.\d+)?)\s+sol\s+to\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i,
    /pay\s+(\d+(?:\.\d+)?)\s+sol\s+to\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i,
  ];

  for (const pattern of patterns) {
    console.log("🔍 Testing pattern:", pattern.toString());
    const match = input.match(pattern);
    if (match) {
      console.log("✅ Pattern matched:", match);
      const amount = parseFloat(match[1]);
      const recipient = match[2];
      if (amount > 0 && recipient) {
        console.log("✅ Valid transaction parsed:", { amount, recipient });
        return { amount, recipient };
      }
    }
  }

  console.log("❌ No pattern matched for input:", input);
  return null;
}

// Helper function to validate Solana address
function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Helper function to get wallet from private key
function getWalletFromPrivateKey(): Keypair | null {
  // Try both possible environment variable names
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  console.log("🔍 Checking for private key in env vars...");
  
  if (!privateKey) {
    console.log("❌ No private key found in environment variables");
    return null;
  }
  
  console.log("✅ Private key found, attempting to create wallet...");
  
  try {
    // Try to decode as base58 first
    const secretKey = bs58.decode(privateKey);
    console.log("✅ Successfully decoded private key as base58");
    return Keypair.fromSecretKey(secretKey);
  } catch {
    try {
      // Try as JSON array format
      const secretKey = new Uint8Array(JSON.parse(privateKey));
      console.log("✅ Successfully decoded private key as JSON array");
      return Keypair.fromSecretKey(secretKey);
    } catch {
      console.log("❌ Failed to decode private key in any format");
      return null;
    }
  }
}

// Extract the main transaction logic into a separate function
async function executeTransaction(command: string, parsed: { amount: number; recipient: string }) {
  const { amount, recipient } = parsed;
  
  // Validate recipient address
  if (!isValidSolanaAddress(recipient)) {
    console.log("❌ Invalid Solana address:", recipient);
    return {
      success: false,
      message: "❌ Invalid Solana address. Please provide a valid Solana wallet address (32-44 characters).",
    };
  }
  
  // Check if wallet is configured
  const wallet = getWalletFromPrivateKey();
  if (!wallet) {
    console.log("❌ Wallet not configured");
    return {
      success: false,
      message: "❌ Wallet not configured. Please set WALLET_PRIVATE_KEY in your environment variables.",
    };
  }
  
  // Safety check - maximum transaction limit
  if (amount > 1) {
    console.log("❌ Amount exceeds safety limit:", amount);
    return {
      success: false,
      message: "❌ Transaction amount exceeds safety limit of 1 SOL. For larger amounts, please contact the administrator.",
    };
  }
  
  try {
    console.log("🔍 Checking wallet balance...");
    // Get current balance
    const connection = new Connection(RPC_URL);
    const balance = await connection.getBalance(wallet.publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL;
    
    console.log("💰 Current balance:", balanceInSol, "SOL");
    
    // Estimate transaction fee (typically ~0.000005 SOL)
    const estimatedFee = 0.000005;
    const totalCost = amount + estimatedFee;
    
    // Check if sufficient balance
    if (balanceInSol < totalCost) {
      console.log("❌ Insufficient balance. Have:", balanceInSol, "Need:", totalCost);
      return {
        success: false,
        message: `❌ Insufficient balance. You have ${balanceInSol.toFixed(9)} SOL but need ${totalCost.toFixed(9)} SOL (including fees).`,
      };
    }
    
    const remainingBalance = balanceInSol - totalCost;
    
    // Create confirmation command
    const confirmationCommand = `confirm send ${amount} SOL to ${recipient}`;
    
    console.log("✅ Transaction prepared successfully");
    
    // Store pending transaction details for simple confirmation
    setPendingTransaction({
      amount,
      recipient,
      sender: wallet.publicKey.toString(),
    });
    
    const message = `
🔐 **TRANSACTION CONFIRMATION REQUIRED**

═══════════════════════════════════════════════════════════════

📋 **TRANSACTION DETAILS**

   💰 **Amount:**           ${amount} SOL
   📤 **From:**             ${wallet.publicKey.toString()}
   📥 **To:**               ${recipient}

═══════════════════════════════════════════════════════════════

💳 **WALLET SUMMARY**

   🏦 **Current Balance:**   ${balanceInSol.toFixed(9)} SOL
   ⚡ **Estimated Fee:**     ~${estimatedFee.toFixed(6)} SOL \n
   💸 **Total Cost:**        ~${totalCost.toFixed(9)} SOL
   💰 **Remaining Balance:** ~${remainingBalance.toFixed(9)} SOL

═══════════════════════════════════════════════════════════════

⚠️  **PLEASE REVIEW ALL DETAILS CAREFULLY BEFORE CONFIRMING**

🟢 **To CONFIRM this transaction, type:**  \`confirm transaction\` or \`yes transaction\`
🔴 **To CANCEL this transaction, type:**   \`cancel transaction\` or \`no transaction\`

═══════════════════════════════════════════════════════════════
`.trim();
    
    return {
      success: true,
      message,
      transactionDetails: {
        amount,
        recipient,
        sender: wallet.publicKey.toString(),
        currentBalance: balanceInSol,
        estimatedFee,
        totalCost,
        remainingBalance,
      },
      confirmationCommand,
    };
    
  } catch (error: any) {
    console.log("❌ Error in sendSolTransaction:", error);
    return {
      success: false,
      message: `❌ Error checking wallet balance: ${error.message}`,
    };
  }
}

export const sendSolTransaction = createTool({
  id: "sendSolTransaction",
  description: "Prepare a SOL transaction for confirmation. This tool parses send commands and shows confirmation details but does NOT execute the transaction.",
  inputSchema: z.object({
    command: z.string().describe("Transaction command like 'send 0.001 SOL to [address]'"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    transactionDetails: z.object({
      amount: z.number(),
      recipient: z.string(),
      sender: z.string(),
      currentBalance: z.number(),
      estimatedFee: z.number(),
      totalCost: z.number(),
      remainingBalance: z.number(),
    }).optional(),
    confirmationCommand: z.string().optional(),
  }),
  execute: async (args) => {
    // Extract command from various possible argument structures
    const command = 
      args.command || 
      args.input?.command || 
      args.context?.command ||
      (typeof args === "string" ? args : "") ||
      "";
    
    console.log("🚀 sendSolTransaction called with command:", command);
    console.log("🚀 Full args:", JSON.stringify(args, null, 2));
    
    // If command is still empty, try to extract from the full args object
    let finalCommand = command;
    if (!finalCommand) {
      // Look for any string value in the args that looks like a transaction command
      const argValues = Object.values(args).flat();
      for (const value of argValues) {
        if (typeof value === "string" && value.toLowerCase().includes("send") && value.toLowerCase().includes("sol")) {
          console.log("🔍 Found command in args:", value);
          finalCommand = value;
          break;
        }
      }
    }
    
    // Parse the transaction command
    const parsed = parseTransactionCommand(finalCommand);
    if (!parsed) {
      console.log("❌ Failed to parse transaction command");
      return {
        success: false,
        message: "❌ Invalid command format. Please use: 'send [amount] SOL to [address]'\n\nExample: send 0.001 SOL to 2Dk2je4iif7yttyGMLbjc8JrqUSMw2wqLPuHxVsJZ2Bg",
      };
    }
    
    return await executeTransaction(finalCommand, parsed);
  },
});