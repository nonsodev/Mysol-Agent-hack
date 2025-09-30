import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { swapTokens } from "../agents/solana-agent/tools/swapTokens";
import { confirmSwap } from "../agents/solana-agent/tools/confirmSwap";
import { getWalletPortfolio } from "../agents/solana-agent/tools/getWalletPortfolio";
import { tokenInfo } from "../agents/solana-agent/tools/tokenInfo";
import { bundleChecker } from "../agents/solana-agent/tools/bundleChecker";

// Step 1: Analyze wallet before trade
const preTradeAnalysisStep = createStep({
  id: "pre-trade-analysis",
  description: "Analyze wallet portfolio before executing trade",
  inputSchema: z.object({
    walletAddress: z.string().optional(),
  }),
  outputSchema: z.object({
    currentBalance: z.object({
      sol: z.number(),
      usd: z.number(),
    }),
    tokenCount: z.number(),
    portfolioValue: z.number(),
    analysis: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.walletAddress) {
      return {
        currentBalance: { sol: 0, usd: 0 },
        tokenCount: 0,
        portfolioValue: 0,
        analysis: "⚠️ No wallet configured - cannot analyze portfolio",
      };
    }
    
    try {
      const portfolio = await getWalletPortfolio.execute({
        context: { walletAddress: inputData.walletAddress }
      });
      
      const portfolioValue = portfolio.sol.usd + portfolio.tokens.reduce((sum, t) => sum + t.usd, 0);
      
      return {
        currentBalance: {
          sol: portfolio.sol.sol,
          usd: portfolio.sol.usd,
        },
        tokenCount: portfolio.tokens.length,
        portfolioValue,
        analysis: `Portfolio: ${portfolio.sol.sol.toFixed(4)} SOL ($${portfolio.sol.usd.toFixed(2)}) + ${portfolio.tokens.length} tokens`,
      };
    } catch (error) {
      return {
        currentBalance: { sol: 0, usd: 0 },
        tokenCount: 0,
        portfolioValue: 0,
        analysis: `❌ Error analyzing portfolio: ${error.message}`,
      };
    }
  },
});

// Step 2: Analyze target token (for buy orders)
const tokenAnalysisStep = createStep({
  id: "token-analysis",
  description: "Analyze target token for risk assessment",
  inputSchema: z.object({
    tradeCommand: z.string(),
  }),
  outputSchema: z.object({
    tokenAnalysis: z.object({
      symbol: z.string().optional(),
      mintAddress: z.string().optional(),
      priceUsd: z.string().nullable(),
      marketCap: z.string().nullable(),
      liquidity: z.string().nullable(),
      isBundled: z.boolean(),
      riskLevel: z.string(),
    }).optional(),
    riskWarnings: z.array(z.string()),
    analysis: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { tradeCommand } = inputData;
    
    // Extract token symbol from trade command
    const buyMatch = tradeCommand.match(/buy\s+[\d.]+\s+sol\s+(?:of|worth\s+of)\s+([a-zA-Z0-9]+)/i);
    const convertMatch = tradeCommand.match(/(?:convert|swap)\s+[\d.]+\s+[a-zA-Z0-9]+\s+(?:to|for)\s+([a-zA-Z0-9]+)/i);
    
    const targetToken = buyMatch?.[1] || convertMatch?.[1];
    
    if (!targetToken || targetToken.toLowerCase() === 'sol') {
      return {
        riskWarnings: [],
        analysis: "✅ Trading SOL - no additional risk analysis needed",
      };
    }
    
    try {
      // Get token info
      const tokenData = await tokenInfo.execute({
        context: { query: targetToken }
      });
      
      // Check for bundles
      const bundleData = await bundleChecker.execute({
        context: { mintAddress: tokenData.mintAddress }
      });
      
      const riskWarnings = [];
      let riskLevel = "LOW";
      
      if (bundleData.isBundled) {
        riskWarnings.push(`🚨 Token is bundled (${bundleData.totalBundles} bundles detected)`);
        riskLevel = "HIGH";
      }
      
      if (bundleData.rugCount > 0) {
        riskWarnings.push(`⚠️ Creator has ${bundleData.rugCount} previous rugs`);
        riskLevel = "EXTREME";
      }
      
      const liquidity = parseFloat(tokenData.liquidityUsd?.replace(/[$,]/g, '') || '0');
      if (liquidity < 10000) {
        riskWarnings.push("⚠️ Low liquidity - high slippage risk");
        if (riskLevel === "LOW") riskLevel = "MEDIUM";
      }
      
      return {
        tokenAnalysis: {
          symbol: tokenData.symbol,
          mintAddress: tokenData.mintAddress,
          priceUsd: tokenData.priceUsd,
          marketCap: tokenData.marketCap,
          liquidity: tokenData.liquidityUsd,
          isBundled: bundleData.isBundled,
          riskLevel,
        },
        riskWarnings,
        analysis: `Token: ${tokenData.symbol} | Price: ${tokenData.priceUsd || "N/A"} | Risk: ${riskLevel}`,
      };
    } catch (error) {
      return {
        riskWarnings: ["❌ Could not analyze target token"],
        analysis: `⚠️ Token analysis failed: ${error.message}`,
      };
    }
  },
});

// Step 3: Prepare trade with risk assessment
const prepareTradeStep = createStep({
  id: "prepare-trade",
  description: "Prepare trade with comprehensive risk assessment",
  inputSchema: z.object({
    tradeCommand: z.string(),
    preTradeData: z.object({
      currentBalance: z.object({
        sol: z.number(),
        usd: z.number(),
      }),
      portfolioValue: z.number(),
    }),
    tokenAnalysis: z.object({
      symbol: z.string().optional(),
      riskLevel: z.string(),
    }).optional(),
    riskWarnings: z.array(z.string()),
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
    riskAssessment: z.object({
      overallRisk: z.string(),
      warnings: z.array(z.string()),
      recommendations: z.array(z.string()),
    }),
  }),
  execute: async ({ inputData }) => {
    const { tradeCommand, preTradeData, tokenAnalysis, riskWarnings } = inputData;
    
    // Prepare the swap
    const swapResult = await swapTokens.execute({
      context: { command: tradeCommand }
    });
    
    // Calculate trade size as percentage of portfolio
    let tradePercentage = 0;
    if (swapResult.swapDetails && preTradeData.portfolioValue > 0) {
      const tradeValueUsd = swapResult.swapDetails.inputAmount * 100; // Rough SOL price estimate
      tradePercentage = (tradeValueUsd / preTradeData.portfolioValue) * 100;
    }
    
    // Assess overall risk
    let overallRisk = "LOW";
    const warnings = [...riskWarnings];
    const recommendations = [];
    
    if (tokenAnalysis?.riskLevel === "HIGH" || tokenAnalysis?.riskLevel === "EXTREME") {
      overallRisk = tokenAnalysis.riskLevel;
    }
    
    if (tradePercentage > 50) {
      warnings.push("⚠️ Trade represents >50% of portfolio value");
      overallRisk = "HIGH";
    } else if (tradePercentage > 25) {
      warnings.push("⚠️ Trade represents >25% of portfolio value");
      if (overallRisk === "LOW") overallRisk = "MEDIUM";
    }
    
    if (preTradeData.currentBalance.sol < 0.01) {
      warnings.push("⚠️ Low SOL balance - ensure sufficient funds for fees");
    }
    
    // Generate recommendations
    if (overallRisk === "HIGH" || overallRisk === "EXTREME") {
      recommendations.push("Consider reducing trade size");
      recommendations.push("Review token fundamentals carefully");
    }
    
    if (tradePercentage > 25) {
      recommendations.push("Consider dollar-cost averaging instead");
    }
    
    if (warnings.length === 0) {
      recommendations.push("Trade appears reasonable - proceed with caution");
    }
    
    return {
      ...swapResult,
      riskAssessment: {
        overallRisk,
        warnings,
        recommendations,
      },
    };
  },
});

// Step 4: Execute trade (conditional)
const executeTradeStep = createStep({
  id: "execute-trade",
  description: "Execute the trade after confirmation",
  inputSchema: z.object({
    confirmation: z.string(),
    riskLevel: z.string(),
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
  execute: async ({ inputData }) => {
    const { confirmation, riskLevel } = inputData;
    
    // For high-risk trades, require explicit confirmation
    if (riskLevel === "HIGH" || riskLevel === "EXTREME") {
      if (!confirmation.toLowerCase().includes("confirm") || !confirmation.toLowerCase().includes("risk")) {
        return {
          success: false,
          message: `❌ High-risk trade requires explicit confirmation. Please type "confirm swap with risk" to proceed.`,
        };
      }
    }
    
    // Execute the swap
    const result = await confirmSwap.execute({
      context: { confirmation }
    });
    
    return result;
  },
});

// Step 5: Post-trade analysis
const postTradeAnalysisStep = createStep({
  id: "post-trade-analysis",
  description: "Analyze portfolio after trade execution",
  inputSchema: z.object({
    walletAddress: z.string().optional(),
    tradeSuccess: z.boolean(),
    preTradeBalance: z.object({
      sol: z.number(),
      usd: z.number(),
    }),
  }),
  outputSchema: z.object({
    newBalance: z.object({
      sol: z.number(),
      usd: z.number(),
    }).optional(),
    balanceChange: z.object({
      sol: z.number(),
      usd: z.number(),
    }).optional(),
    analysis: z.string(),
    recommendations: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const { walletAddress, tradeSuccess, preTradeBalance } = inputData;
    
    if (!tradeSuccess) {
      return {
        analysis: "❌ Trade was not executed - portfolio unchanged",
        recommendations: [
          "Review error message and address any issues",
          "Check wallet balance and network conditions",
          "Consider adjusting slippage tolerance",
        ],
      };
    }
    
    if (!walletAddress) {
      return {
        analysis: "✅ Trade executed but cannot verify portfolio changes",
        recommendations: [
          "Monitor your wallet for the new tokens",
          "Check transaction on Solscan",
          "Set up price alerts for new positions",
        ],
      };
    }
    
    try {
      // Wait a moment for the trade to settle
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const newPortfolio = await getWalletPortfolio.execute({
        context: { walletAddress }
      });
      
      const balanceChange = {
        sol: newPortfolio.sol.sol - preTradeBalance.sol,
        usd: newPortfolio.sol.usd - preTradeBalance.usd,
      };
      
      return {
        newBalance: {
          sol: newPortfolio.sol.sol,
          usd: newPortfolio.sol.usd,
        },
        balanceChange,
        analysis: `✅ Trade completed. SOL balance: ${newPortfolio.sol.sol.toFixed(4)} (${balanceChange.sol >= 0 ? '+' : ''}${balanceChange.sol.toFixed(4)})`,
        recommendations: [
          "Monitor new token position",
          "Consider setting stop-loss levels",
          "Track price movements on DexScreener",
          "Review portfolio allocation",
        ],
      };
    } catch (error) {
      return {
        analysis: `✅ Trade executed but portfolio analysis failed: ${error.message}`,
        recommendations: [
          "Manually check wallet balance",
          "Verify transaction on Solscan",
          "Monitor new positions",
        ],
      };
    }
  },
});

// Step 6: Generate trading report
const generateTradingReportStep = createStep({
  id: "generate-trading-report",
  description: "Generate comprehensive trading report",
  inputSchema: z.object({
    tradeCommand: z.string(),
    preTradeData: z.object({
      currentBalance: z.object({
        sol: z.number(),
        usd: z.number(),
      }),
      analysis: z.string(),
    }),
    tokenAnalysis: z.object({
      symbol: z.string().optional(),
      riskLevel: z.string(),
    }).optional(),
    riskAssessment: z.object({
      overallRisk: z.string(),
      warnings: z.array(z.string()),
      recommendations: z.array(z.string()),
    }),
    tradeResult: z.object({
      success: z.boolean(),
      message: z.string(),
      transactionHash: z.string().optional(),
      solscanUrl: z.string().optional(),
    }),
    postTradeData: z.object({
      newBalance: z.object({
        sol: z.number(),
        usd: z.number(),
      }).optional(),
      balanceChange: z.object({
        sol: z.number(),
        usd: z.number(),
      }).optional(),
      analysis: z.string(),
      recommendations: z.array(z.string()),
    }),
  }),
  outputSchema: z.object({
    report: z.string(),
    success: z.boolean(),
    riskLevel: z.string(),
    recommendations: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const {
      tradeCommand,
      preTradeData,
      tokenAnalysis,
      riskAssessment,
      tradeResult,
      postTradeData,
    } = inputData;
    
    const report = `
# 📊 Trading Report

## 🎯 Trade Command
\`${tradeCommand}\`

## 📈 Pre-Trade Analysis
${preTradeData.analysis}
- **SOL Balance:** ${preTradeData.currentBalance.sol.toFixed(4)} SOL ($${preTradeData.currentBalance.usd.toFixed(2)})

## 🔍 Token Analysis
${tokenAnalysis ? `
- **Token:** ${tokenAnalysis.symbol || "Unknown"}
- **Risk Level:** ${tokenAnalysis.riskLevel}
` : "No token analysis performed"}

## ⚠️ Risk Assessment
**Overall Risk:** ${riskAssessment.overallRisk}

${riskAssessment.warnings.length > 0 ? `
**Warnings:**
${riskAssessment.warnings.map(w => `- ${w}`).join('\n')}
` : ""}

**Pre-Trade Recommendations:**
${riskAssessment.recommendations.map(r => `- ${r}`).join('\n')}

## 🔄 Trade Execution
**Status:** ${tradeResult.success ? "✅ SUCCESS" : "❌ FAILED"}
${tradeResult.transactionHash ? `**Transaction:** [View on Solscan](${tradeResult.solscanUrl})` : ""}

## 📊 Post-Trade Analysis
${postTradeData.analysis}

${postTradeData.balanceChange ? `
**Balance Changes:**
- **SOL:** ${postTradeData.balanceChange.sol >= 0 ? '+' : ''}${postTradeData.balanceChange.sol.toFixed(4)} SOL
- **USD:** ${postTradeData.balanceChange.usd >= 0 ? '+' : ''}$${postTradeData.balanceChange.usd.toFixed(2)}
` : ""}

## 📋 Next Steps
${postTradeData.recommendations.map(r => `- ${r}`).join('\n')}

---
*Trading report generated at ${new Date().toISOString()}*
    `.trim();
    
    return {
      report,
      success: tradeResult.success,
      riskLevel: riskAssessment.overallRisk,
      recommendations: postTradeData.recommendations,
    };
  },
});

// Main workflow
export const tradingWorkflow = createWorkflow({
  id: "trading-workflow",
  description: "Comprehensive trading workflow with risk analysis and portfolio tracking",
  inputSchema: z.object({
    tradeCommand: z.string().describe("Trading command like 'buy 0.01 SOL of BONK'"),
    walletAddress: z.string().optional().describe("Wallet address for portfolio analysis"),
    confirmation: z.string().default("confirm swap").describe("Trade confirmation"),
  }),
  outputSchema: z.object({
    report: z.string(),
    success: z.boolean(),
    riskLevel: z.string(),
    recommendations: z.array(z.string()),
  }),
})
  .then(preTradeAnalysisStep)
  .then(tokenAnalysisStep)
  .then(prepareTradeStep)
  .branch([
    [
      async ({ inputData }) => inputData.confirmation.toLowerCase().includes("confirm"),
      createStep({
        id: "execute-confirmed-trade",
        description: "Execute trade after confirmation",
        inputSchema: z.object({
          confirmation: z.string(),
          riskAssessment: z.object({
            overallRisk: z.string(),
          }),
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
        execute: async ({ inputData, workflowContext }) => {
          const confirmation = workflowContext.inputData.confirmation;
          const riskLevel = inputData.riskAssessment.overallRisk;
          
          return await executeTradeStep.execute({
            inputData: { confirmation, riskLevel }
          });
        },
      })
    ],
    [
      async () => true, // Default case
      createStep({
        id: "trade-not-confirmed",
        description: "Handle case where trade is not confirmed",
        inputSchema: z.any(),
        outputSchema: z.object({
          success: z.boolean(),
          message: z.string(),
        }),
        execute: async () => ({
          success: false,
          message: "Trade was not confirmed by user",
        }),
      })
    ]
  ])
  .then(
    createStep({
      id: "post-trade-analysis-step",
      description: "Analyze portfolio after trade",
      inputSchema: z.object({
        success: z.boolean(),
      }),
      outputSchema: z.object({
        newBalance: z.object({
          sol: z.number(),
          usd: z.number(),
        }).optional(),
        balanceChange: z.object({
          sol: z.number(),
          usd: z.number(),
        }).optional(),
        analysis: z.string(),
        recommendations: z.array(z.string()),
      }),
      execute: async ({ inputData, workflowContext }) => {
        const walletAddress = workflowContext.inputData.walletAddress;
        const preTradeBalance = workflowContext.steps["pre-trade-analysis"].result.currentBalance;
        
        return await postTradeAnalysisStep.execute({
          inputData: {
            walletAddress,
            tradeSuccess: inputData.success,
            preTradeBalance,
          }
        });
      },
    })
  )
  .then(
    createStep({
      id: "combine-trading-data",
      description: "Combine all trading data for final report",
      inputSchema: z.object({
        newBalance: z.object({
          sol: z.number(),
          usd: z.number(),
        }).optional(),
        balanceChange: z.object({
          sol: z.number(),
          usd: z.number(),
        }).optional(),
        analysis: z.string(),
        recommendations: z.array(z.string()),
      }),
      outputSchema: z.object({
        tradeCommand: z.string(),
        preTradeData: z.object({
          currentBalance: z.object({
            sol: z.number(),
            usd: z.number(),
          }),
          analysis: z.string(),
        }),
        tokenAnalysis: z.object({
          symbol: z.string().optional(),
          riskLevel: z.string(),
        }).optional(),
        riskAssessment: z.object({
          overallRisk: z.string(),
          warnings: z.array(z.string()),
          recommendations: z.array(z.string()),
        }),
        tradeResult: z.object({
          success: z.boolean(),
          message: z.string(),
          transactionHash: z.string().optional(),
          solscanUrl: z.string().optional(),
        }),
        postTradeData: z.object({
          newBalance: z.object({
            sol: z.number(),
            usd: z.number(),
          }).optional(),
          balanceChange: z.object({
            sol: z.number(),
            usd: z.number(),
          }).optional(),
          analysis: z.string(),
          recommendations: z.array(z.string()),
        }),
      }),
      execute: async ({ inputData, workflowContext }) => {
        const preTradeResult = workflowContext.steps["pre-trade-analysis"].result;
        const tokenAnalysisResult = workflowContext.steps["token-analysis"].result;
        const prepareTradeResult = workflowContext.steps["prepare-trade"].result;
        
        // Get trade result from either branch
        const tradeResult = workflowContext.steps["execute-confirmed-trade"]?.result || 
                           workflowContext.steps["trade-not-confirmed"]?.result;
        
        return {
          tradeCommand: workflowContext.inputData.tradeCommand,
          preTradeData: {
            currentBalance: preTradeResult.currentBalance,
            analysis: preTradeResult.analysis,
          },
          tokenAnalysis: tokenAnalysisResult.tokenAnalysis,
          riskAssessment: prepareTradeResult.riskAssessment,
          tradeResult,
          postTradeData: inputData,
        };
      },
    })
  )
  .then(generateTradingReportStep)
  .commit();