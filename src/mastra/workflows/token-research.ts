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

// Token Research Workflow - Comprehensive token analysis with investment rating
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
  // Step 1: Search for token (using tool directly)
  .then(searchStep)
  
  // Step 2: Get detailed token information
  .then(
    createStep({
      id: "get-token-details",
      description: "Get comprehensive token profile with price and market data",
      inputSchema: z.object({
        name: z.string(),
        symbol: z.string(),
        mintAddress: z.string(),
        logoURI: z.string().nullable(),
        dailyVolume: z.string().nullable(),
        summary: z.string(),
      }),
      outputSchema: z.object({
        searchData: z.object({
          name: z.string(),
          symbol: z.string(),
          mintAddress: z.string(),
        }),
        tokenDetails: z.object({
          name: z.string(),
          symbol: z.string(),
          mintAddress: z.string(),
          priceUsd: z.string().nullable(),
          liquidityUsd: z.string().nullable(),
          marketCap: z.string().nullable(),
          volume24h: z.string().nullable(),
          priceChange: z.object({
            h24: z.string().nullable(),
          }),
          socials: z.object({
            website: z.string().nullable(),
            twitter: z.string().nullable(),
            telegram: z.string().nullable(),
          }),
        }),
      }),
      execute: async ({ inputData }) => {
        try {
          const tokenDetails = await tokenInfo.execute({
            context: { query: inputData.mintAddress },
            runtimeContext
          });
          
          return {
            searchData: {
              name: inputData.name,
              symbol: inputData.symbol,
              mintAddress: inputData.mintAddress,
            },
            tokenDetails: {
              name: tokenDetails.name,
              symbol: tokenDetails.symbol,
              mintAddress: tokenDetails.mintAddress,
              priceUsd: tokenDetails.priceUsd,
              liquidityUsd: tokenDetails.liquidityUsd,
              marketCap: tokenDetails.marketCap,
              volume24h: tokenDetails.volume24h,
              priceChange: {
                h24: tokenDetails.priceChange.h24,
              },
              socials: {
                website: tokenDetails.socials.website,
                twitter: tokenDetails.socials.twitter,
                telegram: tokenDetails.socials.telegram,
              },
            },
          };
        } catch (error) {
          // Return fallback data if token info fails
          return {
            searchData: {
              name: inputData.name,
              symbol: inputData.symbol,
              mintAddress: inputData.mintAddress,
            },
            tokenDetails: {
              name: inputData.name,
              symbol: inputData.symbol,
              mintAddress: inputData.mintAddress,
              priceUsd: null,
              liquidityUsd: null,
              marketCap: null,
              volume24h: null,
              priceChange: { h24: null },
              socials: { website: null, twitter: null, telegram: null },
            },
          };
        }
      },
    })
  )
  
  // Step 3: Check for bundle activity
  .then(
    createStep({
      id: "analyze-bundle-risk",
      description: "Analyze token for bundle activity and sniper behavior",
      inputSchema: z.object({
        searchData: z.object({
          name: z.string(),
          symbol: z.string(),
          mintAddress: z.string(),
        }),
        tokenDetails: z.any(),
      }),
      outputSchema: z.object({
        searchData: z.any(),
        tokenDetails: z.any(),
        bundleData: z.object({
          isBundled: z.boolean(),
          totalBundles: z.number(),
          creatorRiskLevel: z.string(),
          rugCount: z.number(),
          riskAssessment: z.string(),
        }),
      }),
      execute: async ({ inputData }) => {
        try {
          const bundleResult = await bundleChecker.execute({
            context: { mintAddress: inputData.searchData.mintAddress },
            runtimeContext
          });
          
          return {
            searchData: inputData.searchData,
            tokenDetails: inputData.tokenDetails,
            bundleData: {
              isBundled: bundleResult.isBundled,
              totalBundles: bundleResult.totalBundles,
              creatorRiskLevel: bundleResult.creatorRiskLevel,
              rugCount: bundleResult.rugCount,
              riskAssessment: bundleResult.isBundled ? "High risk due to bundle activity" : "Lower risk, no bundles detected",
            },
          };
        } catch (error) {
          return {
            searchData: inputData.searchData,
            tokenDetails: inputData.tokenDetails,
            bundleData: {
              isBundled: false,
              totalBundles: 0,
              creatorRiskLevel: "Unknown",
              rugCount: 0,
              riskAssessment: "Bundle analysis unavailable",
            },
          };
        }
      },
    })
  )
  
  // Step 4: Calculate risk score and generate report
  .then(
    createStep({
      id: "generate-research-report",
      description: "Generate comprehensive token research report",
      inputSchema: z.object({
        searchData: z.any(),
        tokenDetails: z.any(),
        bundleData: z.any(),
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
      execute: async ({ inputData }) => {
        const { searchData, tokenDetails, bundleData } = inputData;
        
        // Calculate risk score (0-100, higher = more risky)
        let riskScore = 0;
        const riskFactors = [];
        const positiveFactors = [];
        
        // Bundle risk assessment
        if (bundleData.isBundled) {
          riskScore += 40;
          riskFactors.push("Token shows bundle activity");
        } else {
          positiveFactors.push("No bundle activity detected");
        }
        
        if (bundleData.totalBundles > 5) {
          riskScore += 20;
          riskFactors.push(`High bundle count (${bundleData.totalBundles})`);
        }
        
        if (bundleData.rugCount > 0) {
          riskScore += 30;
          riskFactors.push(`Creator has ${bundleData.rugCount} previous rugs`);
        }
        
        // Liquidity risk assessment
        const liquidity = parseFloat(tokenDetails.liquidityUsd?.replace(/[$,]/g, '') || '0');
        if (liquidity < 10000) {
          riskScore += 20;
          riskFactors.push("Low liquidity");
        } else if (liquidity > 100000) {
          positiveFactors.push("High liquidity");
        }
        
        // Volume risk assessment
        const volume = parseFloat(tokenDetails.volume24h?.replace(/[$,]/g, '') || '0');
        if (volume < 1000) {
          riskScore += 15;
          riskFactors.push("Very low trading volume");
        } else if (volume > 50000) {
          positiveFactors.push("Strong trading volume");
        }
        
        // Social presence
        if (tokenDetails.socials.website) {
          positiveFactors.push("Has official website");
        } else {
          riskFactors.push("No official website");
        }
        
        if (tokenDetails.socials.twitter) {
          positiveFactors.push("Active on Twitter");
        }
        
        // Cap risk score
        riskScore = Math.min(100, riskScore);
        
        // Determine investment rating
        let investmentRating = "HIGH RISK";
        if (riskScore < 20) investmentRating = "LOW RISK";
        else if (riskScore < 40) investmentRating = "MEDIUM RISK";
        else if (riskScore < 70) investmentRating = "HIGH RISK";
        else investmentRating = "EXTREME RISK";
        
        // Prepare key metrics
        const keyMetrics = {
          price: tokenDetails.priceUsd || "N/A",
          marketCap: tokenDetails.marketCap || "N/A",
          volume24h: tokenDetails.volume24h || "N/A",
          liquidity: tokenDetails.liquidityUsd || "N/A",
          priceChange24h: tokenDetails.priceChange.h24 || "N/A",
        };
        
        // Generate comprehensive report
        const report = `
# 🔍 Token Research Report: ${searchData.name} (${searchData.symbol})

**Mint Address:** \`${searchData.mintAddress}\`

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
${bundleData.riskAssessment}

## 🌐 Social Links
- **Website:** ${tokenDetails.socials.website || "Not available"}
- **Twitter:** ${tokenDetails.socials.twitter || "Not available"}
- **Telegram:** ${tokenDetails.socials.telegram || "Not available"}

## 📋 Recommendation
Based on the analysis, this token has a **${investmentRating}** rating. ${bundleData.riskAssessment}

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
          tokenData: {
            name: searchData.name,
            symbol: searchData.symbol,
            mintAddress: searchData.mintAddress,
          },
        };
      },
    })
  )
  .commit();
