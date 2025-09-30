import { createWorkflow, createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/di";
import { z } from "zod";
import { getWalletPortfolio } from "../agents/solana-agent/tools/getWalletPortfolio";
import { getNFTPortfolio } from "../agents/solana-agent/tools/getNFTPortfolio";
import { bundleChecker } from "../agents/solana-agent/tools/bundleChecker";

// Create runtime context for tool execution
const runtimeContext = new RuntimeContext();

// Step 1: Use portfolio tool directly as step (recommended pattern)
const portfolioStep = createStep(getWalletPortfolio);

// Step 2: Use NFT tool directly as step  
const nftStep = createStep(getNFTPortfolio);

// Main workflow - Full 5-step comprehensive analysis
export const solanaPortfolioAnalysis = createWorkflow({
  id: "solana-portfolio-analysis",
  description: "Comprehensive Solana wallet portfolio analysis with risk assessment",
  inputSchema: z.object({
    walletAddress: z.string().min(32).describe("Solana wallet address to analyze"),
  }),
  outputSchema: z.object({
    report: z.string(),
    riskScore: z.number(),
    recommendations: z.array(z.string()),
    portfolioData: z.object({
      sol: z.object({
        sol: z.number(),
        usd: z.number(),
      }),
      tokens: z.array(z.any()),
    }),
  }),
})
  // Step 1: Get wallet portfolio (using tool directly)
  .then(portfolioStep)
  
  // Step 2: Analyze top tokens for bundle activity
  .then(
    createStep({
      id: "analyze-bundles",
      description: "Analyze top tokens for bundle activity",
      inputSchema: z.object({
        sol: z.object({
          lamports: z.number(),
          sol: z.number(),
          usd: z.number(),
          breakdown: z.object({
            nativeSOL: z.number(),
            wrappedSOL: z.number(),
          }),
        }),
        tokens: z.array(z.any()),
        text: z.string(),
      }),
      outputSchema: z.object({
        portfolioData: z.any(),
        bundleAnalysis: z.array(z.object({
          mint: z.string(),
          symbol: z.string(),
          usdValue: z.number(),
          isBundled: z.boolean(),
          bundleCount: z.number(),
          riskLevel: z.string(),
        })),
        bundleSummary: z.string(),
        walletAddress: z.string(),
      }),
      execute: async ({ inputData, workflowContext }) => {
        const walletAddress = workflowContext?.inputData?.walletAddress || "";
        const bundleAnalysis = [];
        let bundleSummary = "Bundle Analysis Summary:\n\n";
        
        // Analyze top 3 tokens to avoid rate limits
        const topTokens = inputData.tokens.slice(0, 3);
        
        for (const token of topTokens) {
          try {
            const result = await bundleChecker.execute({
              context: { mintAddress: token.mint },
              runtimeContext
            });
            
            bundleAnalysis.push({
              mint: token.mint,
              symbol: token.tokenSymbol || "Unknown",
              usdValue: token.usd || 0,
              isBundled: result.isBundled,
              bundleCount: result.totalBundles,
              riskLevel: result.creatorRiskLevel,
            });
            
            bundleSummary += `${token.tokenSymbol || "Unknown"}: ${result.isBundled ? "🚨 BUNDLED" : "✅ Clean"} (${result.totalBundles} bundles)\n`;
          } catch (error) {
            bundleAnalysis.push({
              mint: token.mint,
              symbol: token.tokenSymbol || "Unknown", 
              usdValue: token.usd || 0,
              isBundled: false,
              bundleCount: 0,
              riskLevel: "Unknown",
            });
            bundleSummary += `${token.tokenSymbol || "Unknown"}: ❌ Analysis failed\n`;
          }
        }
        
        return {
          portfolioData: inputData,
          bundleAnalysis,
          bundleSummary,
          walletAddress,
        };
      },
    })
  )
  
  // Step 3: Get NFT portfolio data
  .then(
    createStep({
      id: "get-nft-data",
      description: "Fetch NFT portfolio information",
      inputSchema: z.object({
        portfolioData: z.any(),
        bundleAnalysis: z.array(z.any()),
        bundleSummary: z.string(),
        walletAddress: z.string(),
      }),
      outputSchema: z.object({
        portfolioData: z.any(),
        bundleAnalysis: z.array(z.any()),
        bundleSummary: z.string(),
        nftData: z.object({
          collections: z.array(z.any()),
          totalNFTs: z.number(),
          totalCollections: z.number(),
          estimatedPortfolioValue: z.number(),
          text: z.string(),
        }),
        walletAddress: z.string(),
      }),
      execute: async ({ inputData }) => {
        const { walletAddress } = inputData;
        
        try {
          const nftResult = await getNFTPortfolio.execute({
            context: { walletAddress },
            runtimeContext
          });
          
          return {
            ...inputData,
            nftData: nftResult,
          };
        } catch (error) {
          return {
            ...inputData,
            nftData: {
              collections: [],
              totalNFTs: 0,
              totalCollections: 0,
              estimatedPortfolioValue: 0,
              text: `❌ Error fetching NFT portfolio: ${(error as Error).message || 'Unknown error'}`,
            },
          };
        }
      },
    })
  )
  
  // Step 4: Calculate risk scores
  .then(
    createStep({
      id: "calculate-risk",
      description: "Calculate comprehensive risk assessment",
      inputSchema: z.object({
        portfolioData: z.any(),
        bundleAnalysis: z.array(z.any()),
        bundleSummary: z.string(),
        nftData: z.any(),
        walletAddress: z.string(),
      }),
      outputSchema: z.object({
        portfolioData: z.any(),
        bundleAnalysis: z.array(z.any()),
        bundleSummary: z.string(),
        nftData: z.any(),
        riskScore: z.number(),
        riskFactors: z.array(z.string()),
        recommendations: z.array(z.string()),
        walletAddress: z.string(),
      }),
      execute: async ({ inputData }) => {
        const { portfolioData, bundleAnalysis, nftData } = inputData;
        
        // Calculate comprehensive risk score
        let riskScore = 0;
        const riskFactors = [];
        const recommendations = [];
        
        // Bundle risk assessment
        const bundledTokens = bundleAnalysis.filter((t: any) => t.isBundled);
        if (bundledTokens.length > 0) {
          riskScore += bundledTokens.length * 25;
          riskFactors.push(`${bundledTokens.length} bundled tokens detected`);
          recommendations.push("⚠️ Review bundled tokens for potential risks");
        }
        
        // Portfolio concentration risk
        const totalPortfolioValue = portfolioData.sol.usd + portfolioData.tokens.reduce((sum: number, t: any) => sum + (t.usd || 0), 0);
        if (portfolioData.sol.usd / totalPortfolioValue > 0.8) {
          riskScore += 20;
          riskFactors.push("High SOL concentration (>80%)");
          recommendations.push("💰 Consider diversifying SOL holdings");
        }
        
        // Token diversity
        if (portfolioData.tokens.length > 20) {
          riskScore += 15;
          riskFactors.push("High token diversity may indicate speculative trading");
          recommendations.push("🎯 Focus on quality over quantity");
        }
        
        // NFT risk assessment  
        if (nftData.totalNFTs > 100) {
          riskScore += 10;
          riskFactors.push("Large NFT collection");
          recommendations.push("🎨 Monitor NFT floor prices regularly");
        }
        
        // Cap risk score
        riskScore = Math.min(100, riskScore);
        
        // Add positive recommendations
        if (riskFactors.length === 0) {
          recommendations.push("✅ Portfolio shows healthy diversification");
        }
        recommendations.push("📊 Continue regular portfolio monitoring");
        
        return {
          ...inputData,
          riskScore,
          riskFactors,
          recommendations,
        };
      },
    })
  )
  
  // Step 5: Generate comprehensive report
  .then(
    createStep({
      id: "generate-comprehensive-report",
      description: "Generate final comprehensive analysis report",
      inputSchema: z.object({
        portfolioData: z.any(),
        bundleAnalysis: z.array(z.any()),
        bundleSummary: z.string(),
        nftData: z.any(),
        riskScore: z.number(),
        riskFactors: z.array(z.string()),
        recommendations: z.array(z.string()),
        walletAddress: z.string(),
      }),
      outputSchema: z.object({
        report: z.string(),
        riskScore: z.number(),
        recommendations: z.array(z.string()),
        portfolioData: z.object({
          sol: z.object({
            sol: z.number(),
            usd: z.number(),
          }),
          tokens: z.array(z.any()),
        }),
      }),
      execute: async ({ inputData }) => {
        const { portfolioData, bundleAnalysis, bundleSummary, nftData, riskScore, riskFactors, recommendations, walletAddress } = inputData;
        
        const totalPortfolioValue = portfolioData.sol.usd + portfolioData.tokens.reduce((sum: number, t: any) => sum + (t.usd || 0), 0);
        const bundledTokens = bundleAnalysis.filter((t: any) => t.isBundled);
        
        const report = `
# 📊 Comprehensive Portfolio Analysis

**Wallet:** \`${walletAddress}\`

## 💰 Token Holdings
- **SOL Balance:** ${portfolioData.sol.sol.toFixed(4)} SOL ($${portfolioData.sol.usd.toFixed(2)})
- **Token Count:** ${portfolioData.tokens.length} tokens
- **Total Portfolio Value:** $${totalPortfolioValue.toFixed(2)}

## 🚨 Risk Analysis
- **Risk Score:** ${riskScore}/100
- **Bundled Tokens:** ${bundledTokens.length}/${bundleAnalysis.length} analyzed

${bundleSummary}

${riskFactors.length > 0 ? `### Risk Factors:
${riskFactors.map(f => `- ⚠️ ${f}`).join('\n')}` : '### ✅ No major risk factors identified'}

## 🎨 NFT Collection
- **Total NFTs:** ${nftData.totalNFTs}
- **Collections:** ${nftData.totalCollections}
- **Estimated NFT Value:** ${nftData.estimatedPortfolioValue.toFixed(2)} SOL

## 📋 Recommendations
${recommendations.map(r => `- ${r}`).join('\n')}

---
*Comprehensive analysis completed at ${new Date().toISOString()}*
        `.trim();
        
        return {
          report,
          riskScore,
          recommendations,
          portfolioData: {
            sol: portfolioData.sol,
            tokens: portfolioData.tokens,
          },
        };
      },
    })
  )
  .commit();