import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { launchPumpFunToken } from "../agents/solana-agent/tools/launchPumpFunToken";
import { searchToken } from "../agents/solana-agent/tools/searchToken";
import { tokenInfo } from "../agents/solana-agent/tools/tokenInfo";

// Step 1: Validate token launch parameters
const validateLaunchParamsStep = createStep({
  id: "validate-launch-params",
  description: "Validate and prepare token launch parameters",
  inputSchema: z.object({
    tokenName: z.string().min(1).max(32),
    tokenTicker: z.string().min(2).max(10),
    description: z.string().min(1).max(500),
    imageUrl: z.string().url(),
    initialLiquiditySOL: z.number().min(0.0001).max(10).default(0.1),
    slippage: z.number().min(1).max(100).default(5),
    priorityFee: z.number().min(0.00001).max(0.01).default(0.001),
  }),
  outputSchema: z.object({
    tokenName: z.string(),
    tokenTicker: z.string(),
    description: z.string(),
    imageUrl: z.string(),
    options: z.object({
      initialLiquiditySOL: z.number(),
      slippage: z.number(),
      priorityFee: z.number(),
    }),
    estimatedCost: z.number(),
    validationStatus: z.string(),
  }),
  execute: async ({ inputData }) => {
    const {
      tokenName,
      tokenTicker,
      description,
      imageUrl,
      initialLiquiditySOL,
      slippage,
      priorityFee,
    } = inputData;
    
    // Validate image URL
    try {
      const response = await fetch(imageUrl, { method: "HEAD" });
      if (!response.ok) {
        throw new Error(`Image URL returned ${response.status}`);
      }
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.startsWith("image/")) {
        throw new Error("URL does not point to an image");
      }
    } catch (error) {
      throw new Error(`Invalid image URL: ${error.message}`);
    }
    
    // Calculate estimated cost
    const estimatedNetworkFees = 0.01;
    const estimatedCost = initialLiquiditySOL + priorityFee + estimatedNetworkFees;
    
    return {
      tokenName,
      tokenTicker,
      description,
      imageUrl,
      options: {
        initialLiquiditySOL,
        slippage,
        priorityFee,
      },
      estimatedCost,
      validationStatus: "✅ All parameters validated successfully",
    };
  },
});

// Step 2: Check for existing tokens with similar name/ticker
const checkExistingTokensStep = createStep({
  id: "check-existing-tokens",
  description: "Check if tokens with similar name or ticker already exist",
  inputSchema: z.object({
    tokenName: z.string(),
    tokenTicker: z.string(),
  }),
  outputSchema: z.object({
    similarTokens: z.array(
      z.object({
        name: z.string(),
        symbol: z.string(),
        mintAddress: z.string(),
        similarity: z.string(),
      })
    ),
    warningMessage: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const { tokenName, tokenTicker } = inputData;
    const similarTokens = [];
    let warningMessage;
    
    try {
      // Search for tokens with similar ticker
      const tickerResult = await searchToken.execute({
        context: { query: tokenTicker }
      });
      
      if (tickerResult.symbol && tickerResult.symbol.toLowerCase() === tokenTicker.toLowerCase()) {
        similarTokens.push({
          name: tickerResult.name,
          symbol: tickerResult.symbol,
          mintAddress: tickerResult.mintAddress,
          similarity: "Exact ticker match",
        });
      }
      
      // Search for tokens with similar name
      const nameResult = await searchToken.execute({
        context: { query: tokenName }
      });
      
      if (nameResult.name && nameResult.name.toLowerCase().includes(tokenName.toLowerCase())) {
        const alreadyExists = similarTokens.some(t => t.mintAddress === nameResult.mintAddress);
        if (!alreadyExists) {
          similarTokens.push({
            name: nameResult.name,
            symbol: nameResult.symbol,
            mintAddress: nameResult.mintAddress,
            similarity: "Similar name",
          });
        }
      }
    } catch (error) {
      // If search fails, continue with launch (might be a new token)
    }
    
    if (similarTokens.length > 0) {
      warningMessage = `⚠️ Found ${similarTokens.length} existing token(s) with similar name/ticker. Consider using a more unique identifier.`;
    }
    
    return {
      similarTokens,
      warningMessage,
    };
  },
});

// Step 3: Launch the token
const launchTokenStep = createStep({
  id: "launch-token",
  description: "Launch the token on Pump.fun",
  inputSchema: z.object({
    tokenName: z.string(),
    tokenTicker: z.string(),
    description: z.string(),
    imageUrl: z.string(),
    options: z.object({
      initialLiquiditySOL: z.number(),
      slippage: z.number(),
      priorityFee: z.number(),
    }),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    signature: z.string().optional(),
    tokenAddress: z.string().optional(),
    solscanUrl: z.string().optional(),
    gmgnUrl: z.string().optional(),
    transactionCost: z.object({
      totalCost: z.number(),
      breakdown: z.object({
        initialLiquidity: z.number(),
        priorityFee: z.number(),
        networkFees: z.number(),
      }),
    }).optional(),
  }),
  execute: async ({ inputData }) => {
    const result = await launchPumpFunToken.execute({
      context: inputData
    });
    return result;
  },
});

// Step 4: Verify token launch and get initial data
const verifyLaunchStep = createStep({
  id: "verify-launch",
  description: "Verify token launch and fetch initial token data",
  inputSchema: z.object({
    success: z.boolean(),
    tokenAddress: z.string().optional(),
    signature: z.string().optional(),
  }),
  outputSchema: z.object({
    verificationStatus: z.string(),
    tokenData: z.object({
      name: z.string(),
      symbol: z.string(),
      mintAddress: z.string(),
      priceUsd: z.string().nullable(),
      liquidityUsd: z.string().nullable(),
      marketCap: z.string().nullable(),
    }).optional(),
    nextSteps: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.success || !inputData.tokenAddress) {
      return {
        verificationStatus: "❌ Token launch failed - no verification possible",
        nextSteps: [
          "Review error message and fix any issues",
          "Ensure sufficient SOL balance for launch",
          "Verify all parameters are correct",
          "Try launching again",
        ],
      };
    }
    
    // Wait a moment for the token to be indexed
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    try {
      // Try to fetch token info to verify it exists
      const tokenData = await tokenInfo.execute({
        context: { query: inputData.tokenAddress }
      });
      
      return {
        verificationStatus: "✅ Token launch verified successfully",
        tokenData: {
          name: tokenData.name,
          symbol: tokenData.symbol,
          mintAddress: tokenData.mintAddress,
          priceUsd: tokenData.priceUsd,
          liquidityUsd: tokenData.liquidityUsd,
          marketCap: tokenData.marketCap,
        },
        nextSteps: [
          "Monitor token price and liquidity",
          "Share token address with community",
          "Consider adding more liquidity if needed",
          "Track trading activity on DexScreener",
          "Engage with the community on social media",
        ],
      };
    } catch (error) {
      return {
        verificationStatus: "⚠️ Token launched but verification pending (may take a few minutes to index)",
        nextSteps: [
          "Wait 5-10 minutes for token to be indexed",
          "Check Solscan for transaction confirmation",
          "Monitor DexScreener for trading activity",
          "Share token address once confirmed",
        ],
      };
    }
  },
});

// Step 5: Generate launch report
const generateLaunchReportStep = createStep({
  id: "generate-launch-report",
  description: "Generate comprehensive token launch report",
  inputSchema: z.object({
    launchParams: z.object({
      tokenName: z.string(),
      tokenTicker: z.string(),
      description: z.string(),
      estimatedCost: z.number(),
    }),
    similarTokens: z.array(z.any()),
    warningMessage: z.string().optional(),
    launchResult: z.object({
      success: z.boolean(),
      message: z.string(),
      signature: z.string().optional(),
      tokenAddress: z.string().optional(),
      solscanUrl: z.string().optional(),
      gmgnUrl: z.string().optional(),
      transactionCost: z.object({
        totalCost: z.number(),
        breakdown: z.object({
          initialLiquidity: z.number(),
          priorityFee: z.number(),
          networkFees: z.number(),
        }),
      }).optional(),
    }),
    verification: z.object({
      verificationStatus: z.string(),
      tokenData: z.object({
        name: z.string(),
        symbol: z.string(),
        mintAddress: z.string(),
        priceUsd: z.string().nullable(),
        liquidityUsd: z.string().nullable(),
        marketCap: z.string().nullable(),
      }).optional(),
      nextSteps: z.array(z.string()),
    }),
  }),
  outputSchema: z.object({
    report: z.string(),
    success: z.boolean(),
    tokenAddress: z.string().optional(),
    totalCost: z.number().optional(),
    recommendations: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const { launchParams, similarTokens, warningMessage, launchResult, verification } = inputData;
    
    const report = `
# 🚀 Token Launch Report: ${launchParams.tokenName} (${launchParams.tokenTicker})

## 📋 Launch Summary
**Status:** ${launchResult.success ? "✅ SUCCESS" : "❌ FAILED"}
**Token Address:** ${launchResult.tokenAddress ? `\`${launchResult.tokenAddress}\`` : "N/A"}
**Transaction:** ${launchResult.solscanUrl ? `[View on Solscan](${launchResult.solscanUrl})` : "N/A"}

## 💰 Cost Breakdown
${launchResult.transactionCost ? `
- **Initial Liquidity:** ${launchResult.transactionCost.breakdown.initialLiquidity} SOL
- **Priority Fee:** ${launchResult.transactionCost.breakdown.priorityFee} SOL
- **Network Fees:** ${launchResult.transactionCost.breakdown.networkFees} SOL
- **Total Cost:** ${launchResult.transactionCost.totalCost} SOL
` : `**Estimated Cost:** ${launchParams.estimatedCost} SOL`}

## 🔍 Pre-Launch Analysis
${warningMessage || "✅ No similar tokens found"}

${similarTokens.length > 0 ? `
**Similar Tokens Found:**
${similarTokens.map(t => `- ${t.name} (${t.symbol}) - ${t.similarity}`).join('\n')}
` : ""}

## ✅ Verification Status
${verification.verificationStatus}

${verification.tokenData ? `
**Token Data:**
- **Name:** ${verification.tokenData.name}
- **Symbol:** ${verification.tokenData.symbol}
- **Price:** ${verification.tokenData.priceUsd || "N/A"}
- **Liquidity:** ${verification.tokenData.liquidityUsd || "N/A"}
- **Market Cap:** ${verification.tokenData.marketCap || "N/A"}
` : ""}

## 📋 Next Steps
${verification.nextSteps.map(step => `- ${step}`).join('\n')}

${launchResult.gmgnUrl ? `
## 🔗 Quick Links
- **GMGN:** [View Token](${launchResult.gmgnUrl})
- **Solscan:** [View Transaction](${launchResult.solscanUrl})
` : ""}

---
*Launch completed at ${new Date().toISOString()}*
    `.trim();
    
    return {
      report,
      success: launchResult.success,
      tokenAddress: launchResult.tokenAddress,
      totalCost: launchResult.transactionCost?.totalCost,
      recommendations: verification.nextSteps,
    };
  },
});

// Main workflow
export const tokenLaunchWorkflow = createWorkflow({
  id: "token-launch-workflow",
  description: "Complete token launch workflow with validation, similarity check, and verification",
  inputSchema: z.object({
    tokenName: z.string().min(1).max(32),
    tokenTicker: z.string().min(2).max(10),
    description: z.string().min(1).max(500),
    imageUrl: z.string().url(),
    initialLiquiditySOL: z.number().min(0.0001).max(10).default(0.1),
    slippage: z.number().min(1).max(100).default(5),
    priorityFee: z.number().min(0.00001).max(0.01).default(0.001),
  }),
  outputSchema: z.object({
    report: z.string(),
    success: z.boolean(),
    tokenAddress: z.string().optional(),
    totalCost: z.number().optional(),
    recommendations: z.array(z.string()),
  }),
})
  .then(validateLaunchParamsStep)
  .then(checkExistingTokensStep)
  .then(launchTokenStep)
  .then(verifyLaunchStep)
  .then(
    createStep({
      id: "combine-launch-data",
      description: "Combine all launch data for final report",
      inputSchema: z.object({
        verificationStatus: z.string(),
        tokenData: z.object({
          name: z.string(),
          symbol: z.string(),
          mintAddress: z.string(),
          priceUsd: z.string().nullable(),
          liquidityUsd: z.string().nullable(),
          marketCap: z.string().nullable(),
        }).optional(),
        nextSteps: z.array(z.string()),
      }),
      outputSchema: z.object({
        launchParams: z.object({
          tokenName: z.string(),
          tokenTicker: z.string(),
          description: z.string(),
          estimatedCost: z.number(),
        }),
        similarTokens: z.array(z.any()),
        warningMessage: z.string().optional(),
        launchResult: z.object({
          success: z.boolean(),
          message: z.string(),
          signature: z.string().optional(),
          tokenAddress: z.string().optional(),
          solscanUrl: z.string().optional(),
          gmgnUrl: z.string().optional(),
          transactionCost: z.object({
            totalCost: z.number(),
            breakdown: z.object({
              initialLiquidity: z.number(),
              priorityFee: z.number(),
              networkFees: z.number(),
            }),
          }).optional(),
        }),
        verification: z.object({
          verificationStatus: z.string(),
          tokenData: z.object({
            name: z.string(),
            symbol: z.string(),
            mintAddress: z.string(),
            priceUsd: z.string().nullable(),
            liquidityUsd: z.string().nullable(),
            marketCap: z.string().nullable(),
          }).optional(),
          nextSteps: z.array(z.string()),
        }),
      }),
      execute: async ({ inputData, workflowContext }) => {
        const validateResult = workflowContext.steps["validate-launch-params"].result;
        const checkResult = workflowContext.steps["check-existing-tokens"].result;
        const launchResult = workflowContext.steps["launch-token"].result;
        
        return {
          launchParams: {
            tokenName: validateResult.tokenName,
            tokenTicker: validateResult.tokenTicker,
            description: validateResult.description,
            estimatedCost: validateResult.estimatedCost,
          },
          similarTokens: checkResult.similarTokens,
          warningMessage: checkResult.warningMessage,
          launchResult,
          verification: inputData,
        };
      },
    })
  )
  .then(generateLaunchReportStep)
  .commit();