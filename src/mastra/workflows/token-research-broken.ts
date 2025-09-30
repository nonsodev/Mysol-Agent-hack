import { createWorkflow, createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/di";
import { z } from "zod";
import { searchToken } from "../agents/solana-agent/tools/searchToken";
import { tokenInfo } from "../agents/solana-agent/tools/tokenInfo";
import { bundleChecker } from "../agents/solana-agent/tools/bundleChecker";

// Create runtime context for tool execution
const runtimeContext = new RuntimeContext();

// Use tools directly as steps (recommended Mastra pattern)
const searchStep = createStep(searchToken);
const infoStep = createStep(tokenInfo);
const bundleStep = createStep(bundleChecker);

// Step 2: Get detailed token information
const getTokenInfoStep = createStep({
  id: "get-token-info",
  description: "Get comprehensive token profile with price and market data",
  inputSchema: z.object({
    mintAddress: z.string(),
  }),
  outputSchema: z.object({
    name: z.string(),
    symbol: z.string(),
    mintAddress: z.string(),
    logoURI: z.string().nullable(),
    dailyVolume: z.string().nullable(),
    priceUsd: z.string().nullable(),
    liquidityUsd: z.string().nullable(),
    marketCap: z.string().nullable(),
    fdv: z.string().nullable(),
    volume24h: z.string().nullable(),
    priceChange: z.object({
      h24: z.string().nullable(),
      h6: z.string().nullable(),
      h1: z.string().nullable(),
      m5: z.string().nullable(),
    }),
    txns: z.object({
      buy: z.string().nullable(),
      sell: z.string().nullable(),
      total: z.string().nullable(),
    }),
    socials: z.object({
      website: z.string().nullable(),
      twitter: z.string().nullable(),
      telegram: z.string().nullable(),
      discord: z.string().nullable(),
    }),
    dexScreenerUrl: z.string().nullable(),
    summary: z.string(),
  }),
  execute: async ({ inputData }) => {
    const result = await tokenInfo.execute({
      context: { query: inputData.mintAddress }
    });
    return result;
  },
});

// Step 3: Check for bundle activity
const checkBundlesStep = createStep({
  id: "check-bundles",
  description: "Analyze token for bundle activity and sniper behavior",
  inputSchema: z.object({
    mintAddress: z.string(),
  }),
  outputSchema: z.object({
    isBundled: z.boolean(),
    ticker: z.string(),
    totalBundles: z.number(),
    totalPercentageBundled: z.number(),
    totalHoldingPercentage: z.number(),
    totalHoldingAmount: z.number(),
    bonded: z.boolean(),
    creatorRiskLevel: z.string(),
    rugCount: z.number(),
    summary: z.object({
      bundleStatus: z.string(),
      ticker: z.string(),
      metrics: z.object({
        totalBundles: z.number(),
        totalSolSpent: z.string(),
        bundledPercentage: z.string(),
        heldPercentage: z.string(),
        heldTokens: z.string(),
        bonded: z.string(),
      }),
      creator: z.object({
        address: z.string(),
        riskLevel: z.string(),
        currentHoldings: z.number(),
        rugCount: z.number(),
        previousCoins: z.number(),
        holdingPercentage: z.string(),
      }).nullable(),
      bundles: z.array(z.any()),
      distribution: z.object({
        distributedAmount: z.string(),
        distributedPercentage: z.string(),
        distributedWallets: z.number(),
        currentHoldingsInBundles: z.string(),
        currentHoldingsPercentage: z.string(),
      }).nullable(),
      characteristics: z.object({
        primaryCategory: z.string(),
        bundleSizeRange: z.string(),
        bundlePercentageRange: z.string(),
        totalWalletsInBundles: z.number(),
      }).nullable(),
      assessment: z.object({
        riskLevel: z.string(),
        recommendation: z.string(),
        keyFindings: z.array(z.string()),
      }),
      links: z.object({
        trenchRadar: z.string(),
        solscan: z.string(),
      }),
    }),
    formattedSummary: z.string(),
  }),
  execute: async ({ inputData }) => {
    const result = await bundleChecker.execute({
      context: { mintAddress: inputData.mintAddress }
    });
    return result;
  },
});

// Step 4: Generate research report
const generateResearchReportStep = createStep({
  id: "generate-research-report",
  description: "Generate comprehensive token research report",
  inputSchema: z.object({
    searchResult: z.object({
      name: z.string(),
      symbol: z.string(),
      mintAddress: z.string(),
    }),
    tokenInfo: z.object({
      priceUsd: z.string().nullable(),
      marketCap: z.string().nullable(),
      volume24h: z.string().nullable(),
      liquidityUsd: z.string().nullable(),
      priceChange: z.object({
        h24: z.string().nullable(),
      }),
      socials: z.object({
        website: z.string().nullable(),
        twitter: z.string().nullable(),
        telegram: z.string().nullable(),
      }),
    }),
    bundleInfo: z.object({
      isBundled: z.boolean(),
      totalBundles: z.number(),
      creatorRiskLevel: z.string(),
      rugCount: z.number(),
      summary: z.object({
        assessment: z.object({
          riskLevel: z.string(),
          recommendation: z.string(),
        }),
      }),
    }),
  }),
  outputSchema: z.object({
    report: z.string(),
    riskScore: z.number(),
    investmentRating: z.string(),
    keyMetrics: z.object({
      price: z.string(),
      marketCap: z.string(),
      volume24h: z.string(),
      liquidity: z.string(),
      priceChange24h: z.string(),
    }),
    riskFactors: z.array(z.string()),
    positiveFactors: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const { searchResult, tokenInfo, bundleInfo } = inputData;
    
    // Calculate risk score (0-100, higher = more risky)
    let riskScore = 0;
    
    // Bundle risk
    if (bundleInfo.isBundled) riskScore += 40;
    if (bundleInfo.totalBundles > 5) riskScore += 20;
    if (bundleInfo.rugCount > 0) riskScore += 30;
    
    // Liquidity risk
    const liquidity = parseFloat(tokenInfo.liquidityUsd?.replace(/[$,]/g, '') || '0');
    if (liquidity < 10000) riskScore += 20;
    else if (liquidity < 50000) riskScore += 10;
    
    // Volume risk
    const volume = parseFloat(tokenInfo.volume24h?.replace(/[$,]/g, '') || '0');
    if (volume < 1000) riskScore += 15;
    else if (volume < 10000) riskScore += 5;
    
    riskScore = Math.min(100, riskScore);
    
    // Determine investment rating
    let investmentRating = "HIGH RISK";
    if (riskScore < 20) investmentRating = "LOW RISK";
    else if (riskScore < 40) investmentRating = "MEDIUM RISK";
    else if (riskScore < 70) investmentRating = "HIGH RISK";
    else investmentRating = "EXTREME RISK";
    
    // Identify risk factors
    const riskFactors = [];
    if (bundleInfo.isBundled) riskFactors.push("Token shows bundle activity");
    if (bundleInfo.rugCount > 0) riskFactors.push(`Creator has ${bundleInfo.rugCount} previous rugs`);
    if (liquidity < 10000) riskFactors.push("Low liquidity");
    if (volume < 1000) riskFactors.push("Very low trading volume");
    if (!tokenInfo.socials.website) riskFactors.push("No official website");
    
    // Identify positive factors
    const positiveFactors = [];
    if (!bundleInfo.isBundled) positiveFactors.push("No bundle activity detected");
    if (liquidity > 100000) positiveFactors.push("High liquidity");
    if (volume > 50000) positiveFactors.push("Strong trading volume");
    if (tokenInfo.socials.website) positiveFactors.push("Has official website");
    if (tokenInfo.socials.twitter) positiveFactors.push("Active on Twitter");
    
    const keyMetrics = {
      price: tokenInfo.priceUsd || "N/A",
      marketCap: tokenInfo.marketCap || "N/A",
      volume24h: tokenInfo.volume24h || "N/A",
      liquidity: tokenInfo.liquidityUsd || "N/A",
      priceChange24h: tokenInfo.priceChange.h24 || "N/A",
    };
    
    const report = `
# 🔍 Token Research Report: ${searchResult.name} (${searchResult.symbol})

**Mint Address:** \`${searchResult.mintAddress}\`

## 📊 Investment Rating: ${investmentRating}
**Risk Score:** ${riskScore}/100

## 💰 Key Metrics
- **Price:** ${keyMetrics.price}
- **Market Cap:** ${keyMetrics.marketCap}
- **24h Volume:** ${keyMetrics.volume24h}
- **Liquidity:** ${keyMetrics.liquidity}
- **24h Change:** ${keyMetrics.priceChange24h}

## ⚠️ Risk Factors
${riskFactors.length > 0 ? riskFactors.map(r => `- ${r}`).join('\n') : '- No major risk factors identified'}

## ✅ Positive Factors
${positiveFactors.length > 0 ? positiveFactors.map(p => `- ${p}`).join('\n') : '- Limited positive factors identified'}

## 🚨 Bundle Analysis
${bundleInfo.summary.assessment.recommendation}

## 🌐 Social Links
- **Website:** ${tokenInfo.socials.website || "Not available"}
- **Twitter:** ${tokenInfo.socials.twitter || "Not available"}
- **Telegram:** ${tokenInfo.socials.telegram || "Not available"}

## 📋 Recommendation
${bundleInfo.summary.assessment.recommendation}

---
*Research completed at ${new Date().toISOString()}*
    `.trim();
    
    return {
      report,
      riskScore,
      investmentRating,
      keyMetrics,
      riskFactors,
      positiveFactors,
    };
  },
});

// Main workflow
export const tokenResearch = createWorkflow({
  id: "token-research",
  description: "Comprehensive token research with risk analysis and investment rating",
  inputSchema: z.object({
    query: z.string().min(1).describe("Token name, symbol, or address to research"),
  }),
  outputSchema: z.object({
    report: z.string(),
    riskScore: z.number(),
    investmentRating: z.string(),
    keyMetrics: z.object({
      price: z.string(),
      marketCap: z.string(),
      volume24h: z.string(),
      liquidity: z.string(),
      priceChange24h: z.string(),
    }),
    riskFactors: z.array(z.string()),
    positiveFactors: z.array(z.string()),
    tokenData: z.object({
      name: z.string(),
      symbol: z.string(),
      mintAddress: z.string(),
    }),
  }),
})
  .then(searchTokenStep)
  .parallel([
    createStep({
      id: "get-token-info-parallel",
      description: "Get token info in parallel",
      inputSchema: z.object({
        mintAddress: z.string(),
      }),
      outputSchema: z.object({
        name: z.string(),
        symbol: z.string(),
        mintAddress: z.string(),
        logoURI: z.string().nullable(),
        dailyVolume: z.string().nullable(),
        priceUsd: z.string().nullable(),
        liquidityUsd: z.string().nullable(),
        marketCap: z.string().nullable(),
        fdv: z.string().nullable(),
        volume24h: z.string().nullable(),
        priceChange: z.object({
          h24: z.string().nullable(),
          h6: z.string().nullable(),
          h1: z.string().nullable(),
          m5: z.string().nullable(),
        }),
        txns: z.object({
          buy: z.string().nullable(),
          sell: z.string().nullable(),
          total: z.string().nullable(),
        }),
        socials: z.object({
          website: z.string().nullable(),
          twitter: z.string().nullable(),
          telegram: z.string().nullable(),
          discord: z.string().nullable(),
        }),
        dexScreenerUrl: z.string().nullable(),
        summary: z.string(),
      }),
      execute: async ({ inputData }) => {
        const result = await tokenInfo.execute({
          context: { query: inputData.mintAddress }
        });
        return result;
      },
    }),
    checkBundlesStep
  ])
  .then(
    createStep({
      id: "combine-research-data",
      description: "Combine all research data for final report",
      inputSchema: z.object({
        name: z.string(),
        symbol: z.string(),
        mintAddress: z.string(),
        logoURI: z.string().nullable(),
        dailyVolume: z.string().nullable(),
        priceUsd: z.string().nullable(),
        liquidityUsd: z.string().nullable(),
        marketCap: z.string().nullable(),
        fdv: z.string().nullable(),
        volume24h: z.string().nullable(),
        priceChange: z.object({
          h24: z.string().nullable(),
          h6: z.string().nullable(),
          h1: z.string().nullable(),
          m5: z.string().nullable(),
        }),
        txns: z.object({
          buy: z.string().nullable(),
          sell: z.string().nullable(),
          total: z.string().nullable(),
        }),
        socials: z.object({
          website: z.string().nullable(),
          twitter: z.string().nullable(),
          telegram: z.string().nullable(),
          discord: z.string().nullable(),
        }),
        dexScreenerUrl: z.string().nullable(),
        summary: z.string(),
        isBundled: z.boolean(),
        ticker: z.string(),
        totalBundles: z.number(),
        totalPercentageBundled: z.number(),
        totalHoldingPercentage: z.number(),
        totalHoldingAmount: z.number(),
        bonded: z.boolean(),
        creatorRiskLevel: z.string(),
        rugCount: z.number(),
        formattedSummary: z.string(),
      }),
      outputSchema: z.object({
        searchResult: z.object({
          name: z.string(),
          symbol: z.string(),
          mintAddress: z.string(),
        }),
        tokenInfo: z.object({
          priceUsd: z.string().nullable(),
          marketCap: z.string().nullable(),
          volume24h: z.string().nullable(),
          liquidityUsd: z.string().nullable(),
          priceChange: z.object({
            h24: z.string().nullable(),
          }),
          socials: z.object({
            website: z.string().nullable(),
            twitter: z.string().nullable(),
            telegram: z.string().nullable(),
          }),
        }),
        bundleInfo: z.object({
          isBundled: z.boolean(),
          totalBundles: z.number(),
          creatorRiskLevel: z.string(),
          rugCount: z.number(),
          summary: z.object({
            assessment: z.object({
              riskLevel: z.string(),
              recommendation: z.string(),
            }),
          }),
        }),
      }),
      execute: async ({ inputData, workflowContext }) => {
        const searchResult = workflowContext.steps["search-token"].result;
        
        return {
          searchResult: {
            name: searchResult.name,
            symbol: searchResult.symbol,
            mintAddress: searchResult.mintAddress,
          },
          tokenInfo: {
            priceUsd: inputData.priceUsd,
            marketCap: inputData.marketCap,
            volume24h: inputData.volume24h,
            liquidityUsd: inputData.liquidityUsd,
            priceChange: {
              h24: inputData.priceChange.h24,
            },
            socials: {
              website: inputData.socials.website,
              twitter: inputData.socials.twitter,
              telegram: inputData.socials.telegram,
            },
          },
          bundleInfo: {
            isBundled: inputData.isBundled,
            totalBundles: inputData.totalBundles,
            creatorRiskLevel: inputData.creatorRiskLevel,
            rugCount: inputData.rugCount,
            summary: {
              assessment: {
                riskLevel: inputData.creatorRiskLevel,
                recommendation: `Token analysis: ${inputData.isBundled ? "High risk due to bundle activity" : "Lower risk, no bundles detected"}`,
              },
            },
          },
        };
      },
    })
  )
  .then(generateResearchReportStep)
  .commit();