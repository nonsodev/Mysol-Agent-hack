import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { launchToken, validateTokenConfig, TokenLaunchConfig } from "pump-fun-token-launcher-nokitha";

const RPC_URL = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";

// Helper: Get Keypair from env
function getWalletFromPrivateKey(): Keypair | null {
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  console.log("🔍 [LAUNCH] Checking for private key in env vars...");

  if (!privateKey) {
    console.log("❌ [LAUNCH] No private key found in environment variables");
    return null;
  }

  try {
    // Try base58
    const secretKey = bs58.decode(privateKey);
    console.log("✅ [LAUNCH] Decoded private key as base58");
    return Keypair.fromSecretKey(secretKey);
  } catch {
    try {
      // Try base64
      const secretKey = Uint8Array.from(Buffer.from(privateKey, "base64"));
      console.log("✅ [LAUNCH] Decoded private key as base64");
      return Keypair.fromSecretKey(secretKey);
    } catch {
      try {
        // Try JSON array
        const secretKey = new Uint8Array(JSON.parse(privateKey));
        console.log("✅ [LAUNCH] Decoded private key as JSON array");
        return Keypair.fromSecretKey(secretKey);
      } catch {
        console.log("❌ [LAUNCH] Failed to decode private key in any format");
        return null;
      }
    }
  }
}

// Helper: Validate URL
function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// Helper: Validate image URL
async function validateImageUrl(imageUrl: string): Promise<{ isValid: boolean; error?: string }> {
  if (!isValidUrl(imageUrl)) return { isValid: false, error: "Invalid URL format" };
  try {
    const response = await fetch(imageUrl, { method: "HEAD" });
    const contentType = response.headers.get("content-type");
    if (!response.ok) return { isValid: false, error: `Image URL returned ${response.status}` };
    if (!contentType || !contentType.startsWith("image/")) return { isValid: false, error: "URL does not point to an image" };
    return { isValid: true };
  } catch (error: any) {
    return { isValid: false, error: `Failed to validate image: ${error.message}` };
  }
}

export const launchPumpFunToken = createTool({
  id: "launchPumpFunToken",
  description: "Launch a new token on Pump.fun using the official launcher package.",
  inputSchema: z.object({
    tokenName: z.string().min(1).max(32),
    tokenTicker: z.string().min(2).max(10),
    description: z.string().min(1).max(500),
    imageUrl: z.string().url(),
    options: z
      .object({
        initialLiquiditySOL: z.number().min(0.0001).max(10).default(0.1),
        slippage: z.number().min(1).max(100).default(5),
        priorityFee: z.number().min(0.00001).max(0.01).default(0.001),
      })
      .default({}),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    signature: z.string().optional(),
    tokenAddress: z.string().optional(),
    solscanUrl: z.string().optional(),
    gmgnUrl: z.string().optional(),
    transactionCost: z
      .object({
        totalCost: z.number(),
        breakdown: z.object({
          initialLiquidity: z.number(),
          priorityFee: z.number(),
          networkFees: z.number(),
        }),
      })
      .optional(),
  }),
  execute: async (args) => {
    console.log("🚀 [LAUNCH] Starting Pump.fun token launch process...");
    console.log("📋 [LAUNCH] Input parameters:", JSON.stringify(args, null, 2));

    // Robust extraction from both args and args.context
    const context = args.context || {};
    const tokenName = context.tokenName || args.tokenName || "";
    const tokenTicker = context.tokenTicker || args.tokenTicker || "";
    const description = context.description || args.description || "";
    const imageUrl = context.imageUrl || args.imageUrl || "";
    const options = context.options || args.options || {};

    console.log("🖼️ [DEBUG] imageUrl to validate:", imageUrl);

    // Validate image URL
    const imageValidation = await validateImageUrl(imageUrl);
    if (!imageValidation.isValid) {
      console.log("❌ [LAUNCH] Image validation failed:", imageValidation.error);
      return { success: false, message: `Invalid image URL: ${imageValidation.error}` };
    }

    // Get wallet
    const wallet = getWalletFromPrivateKey();
    if (!wallet) {
      return { success: false, message: "❌ Wallet not configured. Please set WALLET_PRIVATE_KEY in your environment variables." };
    }
    console.log("✅ [LAUNCH] Wallet loaded:", wallet.publicKey.toString());

    // Check balance
    const connection = new Connection(RPC_URL);
    const balance = await connection.getBalance(wallet.publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL;
    console.log("💰 [LAUNCH] Current balance:", balanceInSol, "SOL");

    // Prepare config for launcher (use metadataUrl instead of imageUrl)
    const config: TokenLaunchConfig = {
      name: tokenName,
      symbol: tokenTicker,
      description,
      metadataUrl: imageUrl, // <-- this is the fix!
      initialBuy: options.initialLiquiditySOL,
      slippage: options.slippage,
      priorityFee: options.priorityFee,
    };

    // Debug log for config
    console.log("🛠️ [DEBUG] Launch config:", config);

    // Validate config
    try {
      validateTokenConfig(config);
      console.log("✅ [LAUNCH] Token config validated.");
    } catch (e: any) {
      console.log("❌ [LAUNCH] Token config validation failed:", e.message);
      return { success: false, message: `Token config invalid: ${e.message}` };
    }

    // Estimate cost
    const estimatedNetworkFees = 0.01;
    const totalEstimatedCost = config.initialBuy + config.priorityFee + estimatedNetworkFees;
    if (balanceInSol < totalEstimatedCost) {
      return {
        success: false,
        message: `❌ Insufficient balance. You have ${balanceInSol.toFixed(6)} SOL but need approximately ${totalEstimatedCost.toFixed(6)} SOL for token launch and liquidity.`,
      };
    }

    // Launch token
    try {
      console.log("🚀 [LAUNCH] Launching token using pump-fun-token-launcher...");
      const startTime = Date.now();
      const result = await launchToken(config, wallet, RPC_URL);
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;
      console.log("⏱️ [LAUNCH] Launch completed in", duration, "seconds");
      console.log("🎉 [LAUNCH] Launch result:", JSON.stringify(result, null, 2));

      if (result.success) {
        const signature = result.signature;
        const tokenAddress = result.tokenAddress;
        const solscanUrl = signature ? `https://solscan.io/tx/${signature}` : undefined;
        const gmgnUrl = tokenAddress
          ? `https://gmgn.ai/sol/token/${tokenAddress}?filter=All`
          : undefined;

        // Get final balance
        const finalBalance = await connection.getBalance(wallet.publicKey);
        const finalBalanceInSol = finalBalance / LAMPORTS_PER_SOL;
        const actualCost = balanceInSol - finalBalanceInSol;

        return {
          success: true,
          message: `🎉 Token launched successfully!

Token Address: \`${tokenAddress}\`

Transaction on Solscan: [View Transaction](${solscanUrl})

View your token on GMGN: [View Token on GMGN](${gmgnUrl})`,
          signature,
          tokenAddress,
          solscanUrl,
          gmgnUrl, // <-- this is the gmgn.ai token page
          transactionCost: {
            totalCost: actualCost,
            breakdown: {
              initialLiquidity: config.initialBuy,
              priorityFee: config.priorityFee,
              networkFees: actualCost - config.initialBuy - config.priorityFee,
            },
          },
        };
      } else {
        return {
          success: false,
          message: `❌ Token launch failed: ${result.error || "Unknown error"}`,
        };
      }
    } catch (error: any) {
      console.error("💥 [LAUNCH] Launch failed with error:", error);
      let errorMessage = "❌ Token launch failed: ";
      if (error.message?.includes("insufficient funds")) {
        errorMessage += "Insufficient funds for token launch and liquidity provision.";
      } else if (error.message?.includes("metadata")) {
        errorMessage += "Failed to upload token metadata. Please check your image URL and try again.";
      } else if (error.message?.includes("network")) {
        errorMessage += "Network error. Please check your connection and try again.";
      } else if (error.message?.includes("timeout")) {
        errorMessage += "Transaction timed out. The network may be congested, please try again.";
      } else if (error.message?.includes("slippage")) {
        errorMessage += "Transaction failed due to slippage. Try increasing slippage tolerance.";
      } else {
        errorMessage += error.message || "Unknown error occurred during token launch.";
      }
      return { success: false, message: errorMessage };
    }
  },
});