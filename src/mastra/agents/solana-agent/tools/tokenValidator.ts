import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { validateJupiterLiquidity, batchValidateTokens } from "./jupiterUtils";

export const tokenValidator = createTool({
  id: "tokenValidator",
  description: "Validate token liquidity and trading availability on Jupiter before attempting swaps",
  inputSchema: z.object({
    tokenAddresses: z.array(z.string()).describe("Array of token addresses to validate"),
    minLiquidityUSD: z.number().optional().default(100).describe("Minimum liquidity in USD required"),
    batchSize: z.number().optional().default(5).describe("Number of tokens to validate in parallel"),
  }),
  outputSchema: z.object({
    validTokens: z.array(z.object({
      address: z.string(),
      liquidityUSD: z.number(),
      isValid: z.boolean(),
    })),
    invalidTokens: z.array(z.object({
      address: z.string(),
      error: z.string(),
      liquidityUSD: z.number(),
    })),
    summary: z.string(),
    totalValidated: z.number(),
    validCount: z.number(),
    invalidCount: z.number(),
  }),
  execute: async (args: any) => {
    const tokenAddresses = args.tokenAddresses || args.input?.tokenAddresses || [];
    const minLiquidityUSD = args.minLiquidityUSD || args.input?.minLiquidityUSD || 100;
    const batchSize = args.batchSize || args.input?.batchSize || 5;
    
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
      return {
        validTokens: [],
        invalidTokens: [],
        summary: "❌ No token addresses provided for validation",
        totalValidated: 0,
        validCount: 0,
        invalidCount: 0,
      };
    }
    
    console.log(`🔍 Starting validation of ${tokenAddresses.length} tokens with minimum liquidity $${minLiquidityUSD}`);
    
    try {
      // Batch validate all tokens
      const results = await batchValidateTokens(tokenAddresses, batchSize);
      
      const validTokens = [];
      const invalidTokens = [];
      
      for (const [address, result] of results.entries()) {
        if (result.isValid && result.liquidityUSD >= minLiquidityUSD) {
          validTokens.push({
            address,
            liquidityUSD: result.liquidityUSD,
            isValid: true,
          });
        } else {
          invalidTokens.push({
            address,
            error: result.error || `Insufficient liquidity ($${result.liquidityUSD} < $${minLiquidityUSD})`,
            liquidityUSD: result.liquidityUSD,
          });
        }
      }
      
      const summary = `
📊 **Token Validation Results**

✅ **Valid Tokens:** ${validTokens.length}/${tokenAddresses.length}
❌ **Invalid Tokens:** ${invalidTokens.length}/${tokenAddresses.length}
💰 **Min Liquidity Required:** $${minLiquidityUSD}

**Valid Tokens:**
${validTokens.length > 0 ? validTokens.map(t => 
  `• ${t.address.slice(0, 8)}...${t.address.slice(-8)} - $${t.liquidityUSD.toFixed(2)} liquidity`
).join('\n') : 'None'}

**Invalid Tokens:**
${invalidTokens.length > 0 ? invalidTokens.slice(0, 10).map(t => 
  `• ${t.address.slice(0, 8)}...${t.address.slice(-8)} - ${t.error}`
).join('\n') : 'None'}

${invalidTokens.length > 10 ? `... and ${invalidTokens.length - 10} more invalid tokens` : ''}
      `.trim();
      
      return {
        validTokens,
        invalidTokens,
        summary,
        totalValidated: tokenAddresses.length,
        validCount: validTokens.length,
        invalidCount: invalidTokens.length,
      };
      
    } catch (error: any) {
      console.error("❌ Error during token validation:", error);
      return {
        validTokens: [],
        invalidTokens: tokenAddresses.map(address => ({
          address,
          error: error.message || "Validation failed",
          liquidityUSD: 0,
        })),
        summary: `❌ Token validation failed: ${error.message || 'Unknown error'}`,
        totalValidated: tokenAddresses.length,
        validCount: 0,
        invalidCount: tokenAddresses.length,
      };
    }
  },
});

export const singleTokenValidator = createTool({
  id: "singleTokenValidator",
  description: "Validate a single token's liquidity and trading availability on Jupiter",
  inputSchema: z.object({
    tokenAddress: z.string().describe("Token address to validate"),
    minLiquidityUSD: z.number().optional().default(100).describe("Minimum liquidity in USD required"),
  }),
  outputSchema: z.object({
    isValid: z.boolean(),
    liquidityUSD: z.number(),
    error: z.string().optional(),
    recommendation: z.string(),
  }),
  execute: async (args: any) => {
    const tokenAddress = args.tokenAddress || args.input?.tokenAddress || "";
    const minLiquidityUSD = args.minLiquidityUSD || args.input?.minLiquidityUSD || 100;
    
    if (!tokenAddress) {
      return {
        isValid: false,
        liquidityUSD: 0,
        error: "No token address provided",
        recommendation: "❌ Please provide a valid token address",
      };
    }
    
    console.log(`🔍 Validating single token: ${tokenAddress}`);
    
    try {
      const result = await validateJupiterLiquidity(tokenAddress);
      
      const isValid = result.isValid && result.liquidityUSD >= minLiquidityUSD;
      
      let recommendation = "";
      if (isValid) {
        recommendation = `✅ Token is valid for trading with $${result.liquidityUSD.toFixed(2)} liquidity`;
      } else if (result.liquidityUSD > 0 && result.liquidityUSD < minLiquidityUSD) {
        recommendation = `⚠️ Token has low liquidity ($${result.liquidityUSD.toFixed(2)} < $${minLiquidityUSD}). Consider using smaller amounts or higher slippage.`;
      } else {
        recommendation = `❌ Token not suitable for trading: ${result.error || 'No liquidity available'}`;
      }
      
      return {
        isValid,
        liquidityUSD: result.liquidityUSD,
        error: result.error,
        recommendation,
      };
      
    } catch (error: any) {
      console.error("❌ Error validating token:", error);
      return {
        isValid: false,
        liquidityUSD: 0,
        error: error.message || "Validation failed",
        recommendation: `❌ Unable to validate token: ${error.message || 'Unknown error'}`,
      };
    }
  },
});
