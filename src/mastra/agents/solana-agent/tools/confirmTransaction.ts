import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction, 
  SystemProgram, 
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction 
} from "@solana/web3.js";
import bs58 from "bs58";

const RPC_URL = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";

// Helper function to parse confirmation command
function parseConfirmationCommand(input: string): { amount: number; recipient: string } | null {
  console.log("🔍 Parsing confirmation command:", input);
  
  // Check for simple yes/no confirmation first
  const normalizedInput = input.toLowerCase().trim();
  if (normalizedInput === "confirm transaction" || 
      normalizedInput === "yes transaction" ||
      normalizedInput === "confirm send" ||
      normalizedInput === "yes" || 
      normalizedInput === "y" || 
      normalizedInput === "confirm") {
    console.log("✅ Simple confirmation detected:", normalizedInput);
    // Return a special marker that indicates we need to get transaction details from context
    return { amount: -1, recipient: "SIMPLE_CONFIRMATION" };
  }
  
  if (normalizedInput === "cancel transaction" || 
      normalizedInput === "no transaction" ||
      normalizedInput === "cancel send" ||
      normalizedInput === "no" || 
      normalizedInput === "n") {
    console.log("✅ Simple cancellation detected:", normalizedInput);
    // Return a special marker for cancellation
    return { amount: -2, recipient: "SIMPLE_CANCELLATION" };
  }
  
  // Pattern to match full confirmation commands (fallback)
  const pattern = /confirm\s+send\s+(\d+(?:\.\d+)?)\s+sol\s+to\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i;
  
  const match = input.match(pattern);
  if (match) {
    console.log("✅ Confirmation pattern matched:", match);
    const amount = parseFloat(match[1]);
    const recipient = match[2];
    
    if (amount > 0 && recipient) {
      console.log("✅ Valid confirmation parsed:", { amount, recipient });
      return { amount, recipient };
    }
  }
  
  console.log("❌ No confirmation pattern matched for input:", input);
  return null;
}

// Global variable to store pending transaction details
let pendingTransaction: { amount: number; recipient: string; sender: string } | null = null;

// Helper function to set pending transaction (called from sendSolTransaction)
export function setPendingTransaction(details: { amount: number; recipient: string; sender: string }) {
  pendingTransaction = details;
  console.log("📝 Pending transaction set:", pendingTransaction);
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

export const confirmTransaction = createTool({
  id: "confirmTransaction",
  description: "Execute a confirmed SOL transaction. This tool actually sends SOL on the blockchain after user confirmation.",
  inputSchema: z.object({
    confirmationCommand: z.string().describe("Confirmation command like 'confirm send 0.001 SOL to [address]'"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    transactionHash: z.string().optional(),
    solscanUrl: z.string().optional(),
    transactionDetails: z.object({
      amount: z.number(),
      recipient: z.string(),
      sender: z.string(),
      actualFee: z.number(),
      newBalance: z.number(),
    }).optional(),
  }),
  execute: async (args) => {
    // Extract confirmation command from various possible argument structures
    const confirmationCommand = 
      args.confirmationCommand || 
      args.input?.confirmationCommand || 
      args.context?.confirmationCommand ||
      args.command ||
      args.input?.command ||
      args.context?.command ||
      (typeof args === "string" ? args : "") ||
      "";
    
    console.log("🚀 confirmTransaction called with command:", confirmationCommand);
    console.log("🚀 Full args:", JSON.stringify(args, null, 2));
    
    // If confirmationCommand is still empty, try to extract from the full args object
    let finalCommand = confirmationCommand;
    if (!finalCommand) {
      // Look for any string value in the args that looks like a confirmation command
      const argValues = Object.values(args || {}).flat();
      for (const value of argValues) {
        if (typeof value === "string" && value.toLowerCase().includes("confirm") && value.toLowerCase().includes("send")) {
          console.log("🔍 Found confirmation command in args:", value);
          finalCommand = value;
          break;
        }
      }
    }
    
    // If still no command found, check if the entire args object is a string
    if (!finalCommand && typeof args === "string") {
      finalCommand = args;
      console.log("🔍 Using args directly as command:", finalCommand);
    }
    
    // Parse the confirmation command
    const parsed = parseConfirmationCommand(finalCommand);
    if (!parsed) {
      console.log("❌ Failed to parse confirmation command");
      return {
        success: false,
        message: `❌ Invalid confirmation. Please type "confirm transaction" or "cancel transaction" to proceed.\n\nReceived: "${finalCommand}"`,
      };
    }
    
    let { amount, recipient } = parsed;
    
    // Handle simple confirmation
    if (amount === -1 && recipient === "SIMPLE_CONFIRMATION") {
      if (!pendingTransaction) {
        console.log("❌ No pending transaction found for simple confirmation");
        return {
          success: false,
          message: "❌ No pending transaction found. Please initiate a transaction first using 'send [amount] SOL to [address]'.",
        };
      }
      
      console.log("✅ Using pending transaction details:", pendingTransaction);
      amount = pendingTransaction.amount;
      recipient = pendingTransaction.recipient;
      
      // Clear the pending transaction
      pendingTransaction = null;
    }
    
    // Handle simple cancellation
    if (amount === -2 && recipient === "SIMPLE_CANCELLATION") {
      // Clear the pending transaction
      pendingTransaction = null;
      return {
        success: false,
        message: "🚫 **TRANSACTION CANCELLED**\n\nThe SOL transaction has been cancelled. No transaction was executed.",
      };
    }
    
    // Validate recipient address
    if (!isValidSolanaAddress(recipient)) {
      console.log("❌ Invalid Solana address in confirmation:", recipient);
      return {
        success: false,
        message: "❌ Invalid Solana address in confirmation command.",
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
        message: "❌ Transaction amount exceeds safety limit of 1 SOL.",
      };
    }
    
    try {
      console.log("🔍 Getting current balance...");
      const connection = new Connection(RPC_URL);
      
      // Get current balance before transaction
      const initialBalance = await connection.getBalance(wallet.publicKey);
      const initialBalanceInSol = initialBalance / LAMPORTS_PER_SOL;
      
      console.log("💰 Current balance:", initialBalanceInSol, "SOL");
      
      // Check balance again before executing
      const requiredAmount = amount + 0.000005; // amount + estimated fee
      if (initialBalanceInSol < requiredAmount) {
        console.log("❌ Insufficient balance for transaction");
        return {
          success: false,
          message: `❌ Insufficient balance. Current balance: ${initialBalanceInSol.toFixed(9)} SOL, Required: ${requiredAmount.toFixed(9)} SOL`,
        };
      }
      
      // Create the transaction
      const recipientPublicKey = new PublicKey(recipient);
      const lamportsToSend = Math.floor(amount * LAMPORTS_PER_SOL);
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: recipientPublicKey,
          lamports: lamportsToSend,
        })
      );
      
      // Send and confirm the transaction
      console.log(`Sending ${amount} SOL to ${recipient}...`);
      console.log("📤 Broadcasting transaction...");
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet],
        {
          commitment: 'confirmed',
          maxRetries: 3,
        }
      );
      
      console.log("✅ Transaction confirmed with signature:", signature);
      
      // Get new balance after transaction
      const finalBalance = await connection.getBalance(wallet.publicKey);
      const finalBalanceInSol = finalBalance / LAMPORTS_PER_SOL;
      const actualFee = (initialBalance - finalBalance - lamportsToSend) / LAMPORTS_PER_SOL;
      
      const solscanUrl = `https://solscan.io/tx/${signature}`;
      
      const message = `
✅ **TRANSACTION SUCCESSFUL!**

═══════════════════════════════════════════════════════════════

🎉 **TRANSACTION COMPLETED SUCCESSFULLY**

   💰 **Amount Sent:**       ${amount} SOL \n
   📤 **From:**              ${wallet.publicKey.toString()} \n
   📥 **To:**                ${recipient}

═══════════════════════════════════════════════════════════════

🔗 **BLOCKCHAIN DETAILS**

   🆔 **Transaction Hash:**  ${signature}
   ⚡ **Actual Fee:**        ${actualFee.toFixed(9)} SOL
   💳 **New Balance:**       ${finalBalanceInSol.toFixed(9)} SOL

═══════════════════════════════════════════════════════════════

🌐 **VIEW ON BLOCKCHAIN EXPLORER**

   📊 **Solscan Link:** ${solscanUrl}

═══════════════════════════════════════════════════════════════

🚀 **Your transaction has been successfully broadcast to the Solana network and confirmed!**
`.trim();
      
      return {
        success: true,
        message,
        transactionHash: signature,
        solscanUrl,
        transactionDetails: {
          amount,
          recipient,
          sender: wallet.publicKey.toString(),
          actualFee,
          newBalance: finalBalanceInSol,
        },
      };
      
    } catch (error: any) {
      console.error("Transaction failed:", error);
      console.error("Full error details:", JSON.stringify(error, null, 2));
      
      let errorMessage = "❌ Transaction failed: ";
      
      if (error.message.includes("insufficient funds")) {
        errorMessage += "Insufficient funds for transaction and fees.";
      } else if (error.message.includes("blockhash not found")) {
        errorMessage += "Network congestion. Please try again in a moment.";
      } else if (error.message.includes("invalid")) {
        errorMessage += "Invalid transaction parameters.";
      } else {
        errorMessage += error.message || "Unknown error occurred.";
      }
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  },
});
