import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";

const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY";
const TRENCH_API_BASE = "https://trench.bot/api/bundle/bundle_advanced";

// Type definitions based on your reference code
interface BundleAnalysisResponse {
  bonded: boolean;
  bundles: Record<string, BundleDetails>;
  creator_analysis: CreatorAnalysis;
  distributed_amount: number;
  distributed_percentage: number;
  distributed_wallets: number;
  ticker: string;
  total_bundles: number;
  total_holding_amount: number;
  total_holding_percentage: number;
  total_percentage_bundled: number;
  total_sol_spent: number;
  total_tokens_bundled: number;
}

interface BundleDetails {
  bundle_analysis: BundleAnalysis;
  funding_analysis?: FundingAnalysis;
  holding_amount: number;
  holding_percentage: number;
  slot?: number;
  token_percentage: number;
  total_sol: number;
  total_tokens: number;
  unique_wallets: number;
  wallet_categories: Record<string, string>;
  wallet_info: Record<string, WalletInfo>;
}

interface BundleAnalysis {
  category_breakdown: Record<string, number>;
  copytrading_groups: Record<string, string>;
  is_likely_bundle: boolean;
  primary_category: string;
}

interface FundingAnalysis {
  cex_funded_percentage?: number;
  funding_trust_score?: number;
  mixer_funded_percentage?: number;
}

interface WalletInfo {
  sol: number;
  sol_percentage: number;
  token_percentage: number;
  tokens: number;
}

interface CreatorAnalysis {
  address: string;
  current_holdings: number;
  history: CreatorHistory;
  holding_percentage: number;
  risk_level: string;
  warning_flags: (string | null)[];
}

interface CreatorHistory {
  average_market_cap: number;
  high_risk: boolean;
  previous_coins: PreviousCoin[];
  recent_rugs: number;
  rug_count: number;
  rug_percentage: number;
  total_coins_created: number;
}

interface PreviousCoin {
  created_at: number;
  is_rug: boolean;
  market_cap: number;
  mint: string;
  symbol: string;
}

// CHANGED: Added robust mint extraction helper
function extractMintAddress(args: any): string | null {
  let mintAddress =
    args?.input?.mintAddress ||
    args?.mintAddress ||
    args?.context?.mintAddress ||
    null;

  if (typeof args === "string") {
    mintAddress = args;
  }

  if (!mintAddress && args?.input) {
    const inputStr = JSON.stringify(args.input);
    const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const matches = inputStr.match(solanaAddressRegex);

    if (matches) {
      mintAddress = matches.reduce((longest, current) =>
        current.length > longest.length ? current : longest, ""
      );
    }
  }

  if (mintAddress && typeof mintAddress === "string") {
    mintAddress = mintAddress.replace(/['"]/g, "").trim();
    if (mintAddress.length >= 32 && mintAddress.length <= 44) {
      return mintAddress;
    }
  }

  return null;
}

// Helper function to get mint account info for decimals
async function getMintAccountInfo(mintAddress: string) {
  try {
    const response = await axios.post(
      HELIUS_RPC,
      {
        jsonrpc: "2.0",
        id: "1",
        method: "getAccountInfo",
        params: [
          mintAddress,
          {
            encoding: "jsonParsed",
          },
        ],
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const accountInfo = response.data?.result?.value?.data?.parsed?.info;
    return {
      decimals: accountInfo?.decimals || 9,
      supply: accountInfo?.supply || "0",
    };
  } catch (error) {
    return { decimals: 9, supply: "0" };
  }
}

// Helper function to adjust token values based on decimals
function mapTokenDecimals(data: BundleAnalysisResponse, decimals: number): void {
  const tokenKeys = [
    'total_tokens',
    'tokens',
    'total_tokens_bundled',
    'distributed_amount',
    'holding_amount',
    'total_holding_amount',
  ];

  function adjustValue(value: any): any {
    return typeof value === 'number' ? value / Math.pow(10, decimals) : value;
  }

  function traverse(obj: any): void {
    if (typeof obj !== 'object' || obj === null) return;

    for (const key of Object.keys(obj)) {
      if (tokenKeys.includes(key) && typeof obj[key] === 'number') {
        obj[key] = adjustValue(obj[key]);
      } else if (typeof obj[key] === 'object') {
        traverse(obj[key]);
      }
    }
  }

  traverse(data);
}

// Helper function to format numbers
function formatNumber(num: number): string {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

// Helper function to shorten wallet address
function shortenAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

export const bundleChecker = createTool({
  id: "bundleChecker",
  description: "Check if a Solana token (pump.fun launches) is bundled by analyzing wallet clusters and sniper activity. Provides comprehensive bundle analysis with individual bundle details.",
  inputSchema: z.object({
    mintAddress: z.string().min(32).describe("Solana token mint address to analyze for bundles"),
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
      bundles: z.array(z.object({
        bundleNumber: z.number(),
        uniqueWallets: z.number(),
        totalTokens: z.string(),
        totalSol: z.string(),
        tokenPercentage: z.string(),
        holdingPercentage: z.string(),
        primaryCategory: z.string(),
        isLikelyBundle: z.boolean(),
        fundingAnalysis: z.object({
          trustScore: z.string(),
          cexFunded: z.string(),
          mixerFunded: z.string(),
        }).nullable(),
        topWallets: z.array(z.object({
          address: z.string(),
          shortAddress: z.string(),
          tokensBought: z.string(),
          tokenPercentage: z.string(),
          solSpent: z.string(),
          solPercentage: z.string(),
        })),
      })),
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
  execute: async (args) => {
    // CHANGED: Use robust mint extraction
    const mintAddress = extractMintAddress(args);

    if (!mintAddress) {
      throw new Error("mintAddress is required and must be a valid Solana address (32-44 characters)");
    }

    try {
      // Fetch bundle analysis from TrenchBot API
      const response = await axios.get(`${TRENCH_API_BASE}/${mintAddress}`);
    
      if (!response.data) {
        const errorSummary = `# 🔍 **Bundle Analysis: Unknown**


## 📊 **Bundle Detection Summary**


**Bundle Status:** ❌ No Data

**Ticker:** Unknown

**Total Bundles:** 0

**Total SOL Spent:** 0 SOL

**Bundled Total:** 0%

**Held Percentage:** 0%

**Bonded:** No


## 🎯 **Final Assessment**


⚠️ Unable to fetch bundle data. Please make sure this is a pump.fun token.


**Mint Address:** \`${mintAddress}\``;

        return {
          isBundled: false,
          ticker: "Unknown",
          totalBundles: 0,
          totalPercentageBundled: 0,
          totalHoldingPercentage: 0,
          totalHoldingAmount: 0,
          bonded: false,
          creatorRiskLevel: "Unknown",
          rugCount: 0,
          summary: {
            bundleStatus: "❌ No Data",
            ticker: "Unknown",
            metrics: {
              totalBundles: 0,
              totalSolSpent: "0 SOL",
              bundledPercentage: "0%",
              heldPercentage: "0%",
              heldTokens: "N/A",
              bonded: "No",
            },
            creator: null,
            bundles: [],
            distribution: null,
            characteristics: null,
            assessment: {
              riskLevel: "Unknown",
              recommendation: "Unable to fetch bundle data. Please make sure this is a pump.fun token.",
              keyFindings: ["No data available"],
            },
            links: {
              trenchRadar: `https://trench.bot/bundles/${mintAddress}?all=true`,
              solscan: `https://solscan.io/token/${mintAddress}`,
            },
          },
          formattedSummary: errorSummary,
        };
      }

      const analysis: BundleAnalysisResponse = response.data;

      // Get mint info for decimal adjustment
      const mintInfo = await getMintAccountInfo(mintAddress);
    
      // Apply decimal adjustments
      mapTokenDecimals(analysis, mintInfo.decimals);

      // Determine if token is bundled
      const isBundled = analysis.total_bundles > 0 && analysis.total_percentage_bundled > 0;

      // Process bundle entries (sorted by SOL spent, limited to 10)
      const bundleEntries = Object.entries(analysis.bundles || {})
        .sort(([,a], [,b]) => (b.total_sol || 0) - (a.total_sol || 0))
        .slice(0, 10);

      // Build structured summary
      const structuredSummary = {
        bundleStatus: isBundled ? "🚨 BUNDLED" : "✅ Clean",
        ticker: analysis.ticker || "Unknown",
        metrics: {
          totalBundles: analysis.total_bundles || 0,
          totalSolSpent: `${analysis.total_sol_spent?.toFixed(2) || 0} SOL`,
          bundledPercentage: `${analysis.total_percentage_bundled?.toFixed(2) || 0}%`,
          heldPercentage: `${analysis.total_holding_percentage?.toFixed(2) || 0}%`,
          heldTokens: analysis.total_holding_amount ? formatNumber(analysis.total_holding_amount) : "N/A",
          bonded: analysis.bonded ? "Yes" : "No",
        },
        creator: analysis.creator_analysis ? {
          address: analysis.creator_analysis.address,
          riskLevel: analysis.creator_analysis.risk_level || "Unknown",
          currentHoldings: analysis.creator_analysis.current_holdings || 0,
          rugCount: analysis.creator_analysis.history?.rug_count || 0,
          previousCoins: analysis.creator_analysis.history?.total_coins_created || 0,
          holdingPercentage: `${analysis.creator_analysis.holding_percentage?.toFixed(2) || 0}%`,
        } : null,
        bundles: bundleEntries.map(([bundleId, bundle], index) => {
          // Get top 3 wallets for this bundle
          const topWallets = Object.entries(bundle.wallet_info || {})
            .sort(([,a], [,b]) => (b.sol || 0) - (a.sol || 0))
            .slice(0, 3)
            .map(([walletAddress, walletData]) => ({
              address: walletAddress,
              shortAddress: shortenAddress(walletAddress),
              tokensBought: formatNumber(walletData.tokens),
              tokenPercentage: `${walletData.token_percentage?.toFixed(2) || 0}%`,
              solSpent: `${walletData.sol?.toFixed(2) || 0} SOL`,
              solPercentage: `${walletData.sol_percentage?.toFixed(2) || 0}%`,
            }));

          return {
            bundleNumber: index + 1,
            uniqueWallets: bundle.unique_wallets || 0,
            totalTokens: formatNumber(bundle.total_tokens || 0),
            totalSol: `${bundle.total_sol?.toFixed(2) || 0} SOL`,
            tokenPercentage: `${bundle.token_percentage?.toFixed(2) || 0}%`,
            holdingPercentage: `${bundle.holding_percentage?.toFixed(2) || 0}%`,
            primaryCategory: bundle.bundle_analysis?.primary_category || "N/A",
            isLikelyBundle: bundle.bundle_analysis?.is_likely_bundle || false,
            fundingAnalysis: bundle.funding_analysis ? {
              trustScore: `${bundle.funding_analysis.funding_trust_score || 'N/A'}/100`,
              cexFunded: `${bundle.funding_analysis.cex_funded_percentage?.toFixed(2) || '0.00'}%`,
              mixerFunded: `${bundle.funding_analysis.mixer_funded_percentage?.toFixed(2) || '0.00'}%`,
            } : null,
            topWallets,
          };
        }),
        distribution: analysis.distributed_wallets > 0 ? {
          distributedAmount: formatNumber(analysis.distributed_amount || 0),
          distributedPercentage: `${analysis.distributed_percentage?.toFixed(2) || 0}%`,
          distributedWallets: analysis.distributed_wallets || 0,
          currentHoldingsInBundles: formatNumber(analysis.total_holding_amount || 0),
          currentHoldingsPercentage: `${analysis.total_holding_percentage?.toFixed(2) || 0}%`,
        } : null,
        characteristics: bundleEntries.length > 0 ? {
          primaryCategory: bundleEntries[0]?.[1]?.bundle_analysis?.primary_category || "new wallet",
          bundleSizeRange: `2-${Math.max(...bundleEntries.map(([,b]) => b.unique_wallets || 0))} wallets`,
          bundlePercentageRange: `${Math.min(...bundleEntries.map(([,b]) => b.token_percentage || 0)).toFixed(2)}% - ${Math.max(...bundleEntries.map(([,b]) => b.token_percentage || 0)).toFixed(2)}%`,
          totalWalletsInBundles: bundleEntries.reduce((sum, [,b]) => sum + (b.unique_wallets || 0), 0),
        } : null,
        assessment: {
          riskLevel: isBundled ? "⚠️ HIGH RISK" : "✅ LOW RISK",
          recommendation: isBundled 
            ? `This token shows clear signs of coordinated buying through ${analysis.total_bundles} bundles, with ${analysis.total_percentage_bundled?.toFixed(2)}% of tokens involved in bundle transactions. Exercise extreme caution when trading.`
            : "No significant bundling activity detected. This appears to be a clean token launch.",
          keyFindings: [
            ...(isBundled ? [
              `${analysis.total_bundles} bundles detected`,
              `${analysis.total_percentage_bundled?.toFixed(2)}% of supply bundled`,
              `${analysis.total_sol_spent?.toFixed(2)} SOL spent across bundles`,
            ] : ["No bundling detected"]),
            ...(analysis.creator_analysis?.history?.rug_count > 0 ? [
              `Creator has ${analysis.creator_analysis.history.rug_count} previous rugs`
            ] : []),
            ...(analysis.bonded ? ["Token is bonded"] : ["Token is not bonded"]),
          ],
        },
        links: {
          trenchRadar: `https://trench.bot/bundles/${mintAddress}?all=true`,
          solscan: `https://solscan.io/token/${mintAddress}`,
        },
      };

      // Generate formatted markdown summary for easy LLM display
      // Generate chat-friendly formatted summary
      let bundleDetailsText = "";
      if (bundleEntries.length > 0) {
        bundleDetailsText = bundleEntries.map(([bundleId, bundle], index) => {
          const topWallets = Object.entries(bundle.wallet_info || {})
            .sort(([,a], [,b]) => (b.sol || 0) - (a.sol || 0))
            .slice(0, 3);
        
          let walletList = "";
          topWallets.forEach(([addr, data]) => {
            walletList += `      ${shortenAddress(addr)}: ${formatNumber(data.tokens)} tokens (${data.token_percentage?.toFixed(2)}%), ${data.sol?.toFixed(2)} SOL\n`;
          });

          return `**Bundle ${index + 1}:**

• **Wallets:** ${bundle.unique_wallets}

• **Total Tokens:** ${formatNumber(bundle.total_tokens || 0)} (${bundle.token_percentage?.toFixed(2)}%)

• **Total SOL:** ${bundle.total_sol?.toFixed(2)} SOL

• **Category:** ${bundle.bundle_analysis?.primary_category || "N/A"}

• **Top Wallets:**

${walletList}`;
        }).join("\n\n");
      }

      const formattedSummary = `# 🔍 **Bundle Analysis: ${analysis.ticker || "Unknown"}**


## 📊 **Bundle Detection Summary**


**Bundle Status:** ${isBundled ? "🚨 BUNDLED" : "✅ Clean"}

**Ticker:** ${analysis.ticker || "Unknown"}

**Total Bundles:** ${analysis.total_bundles || 0}

**Total SOL Spent:** ${analysis.total_sol_spent?.toFixed(2) || 0} SOL

**Bundled Total:** ${analysis.total_percentage_bundled?.toFixed(2) || 0}%

**Held Percentage:** ${analysis.total_holding_percentage?.toFixed(2) || 0}%

**Held Tokens:** ${analysis.total_holding_amount ? formatNumber(analysis.total_holding_amount) : "N/A"}

**Bonded:** ${analysis.bonded ? "Yes" : "No"}


${analysis.creator_analysis ? `## 👤 **Creator Analysis**


**Creator Address:** \`${analysis.creator_analysis.address}\`

**Risk Level:** ${analysis.creator_analysis.risk_level || "Unknown"}

**Current Holdings:** ${analysis.creator_analysis.current_holdings || 0} tokens

**Previous Coins Created:** ${analysis.creator_analysis.history?.total_coins_created || 0}

**Rug History:** ${analysis.creator_analysis.history?.rug_count || 0} rugs

**Holdings Percentage:** ${analysis.creator_analysis.holding_percentage?.toFixed(2) || 0}%


` : ""}${bundleEntries.length > 0 ? `## 🎯 **Individual Bundle Analysis**


Found **${analysis.total_bundles}** bundles (showing top ${bundleEntries.length}):


${bundleDetailsText}


## 🔍 **Bundle Characteristics**


• **Most bundles are characterized by:** "${bundleEntries[0]?.[1]?.bundle_analysis?.primary_category || "new wallet"}"

• **Bundle sizes vary from:** 2-${Math.max(...bundleEntries.map(([,b]) => b.unique_wallets || 0))} wallets per bundle

• **Individual bundle percentages range from:** ~${Math.min(...bundleEntries.map(([,b]) => b.token_percentage || 0)).toFixed(2)}% to ~${Math.max(...bundleEntries.map(([,b]) => b.token_percentage || 0)).toFixed(2)}% of total supply


` : ""}## 🎯 **Final Assessment**


⚠️ **${isBundled ? "HIGH RISK" : "LOW RISK"}**


${isBundled 
  ? `This token shows clear signs of coordinated buying through ${analysis.total_bundles} bundles, with ${analysis.total_percentage_bundled?.toFixed(2)}% of tokens involved in bundle transactions. Exercise extreme caution when trading.`
  : "No significant bundling activity detected. This appears to be a clean token launch."}


**Mint Address:** \`${mintAddress}\``;

      return {
        isBundled,
        ticker: analysis.ticker || "Unknown",
        totalBundles: analysis.total_bundles || 0,
        totalPercentageBundled: analysis.total_percentage_bundled || 0,
        totalHoldingPercentage: analysis.total_holding_percentage || 0,
        totalHoldingAmount: analysis.total_holding_amount || 0,
        bonded: analysis.bonded || false,
        creatorRiskLevel: analysis.creator_analysis?.risk_level || "Unknown",
        rugCount: analysis.creator_analysis?.history?.rug_count || 0,
        summary: structuredSummary,
        formattedSummary: formattedSummary,
      };

    } catch (error: any) {
      const errorSummary = `# 🔍 **Bundle Analysis: Error**


## 📊 **Bundle Detection Summary**


**Bundle Status:** ❌ Error

**Error:** ${error?.response?.data?.error || error.message || "Unable to fetch bundle data"}


## 🎯 **Final Assessment**


⚠️ Analysis failed. Please make sure this is a pump.fun token.


**Mint Address:** \`${mintAddress}\``;



      return {
        isBundled: false,
        ticker: "Unknown",
        totalBundles: 0,
        totalPercentageBundled: 0,
        totalHoldingPercentage: 0,
        totalHoldingAmount: 0,
        bonded: false,
        creatorRiskLevel: "Unknown",
        rugCount: 0,
        summary: {
          bundleStatus: "❌ Error",
          ticker: "Unknown",
          metrics: {
            totalBundles: 0,
            totalSolSpent: "0 SOL",
            bundledPercentage: "0%",
            heldPercentage: "0%",
            heldTokens: "N/A",
            bonded: "No",
          },
          creator: null,
          bundles: [],
          distribution: null,
          characteristics: null,
          assessment: {
            riskLevel: "Unknown",
            recommendation: `Error analyzing bundles: ${error?.response?.data?.error || error.message || "Unable to fetch bundle data. Please make sure this is a pump.fun token."}`,
            keyFindings: ["Analysis failed"],
          },
          links: {
            trenchRadar: `https://trench.bot/bundles/${mintAddress}?all=true`,
            solscan: `https://solscan.io/token/${mintAddress}`,
          },
        },
        formattedSummary: errorSummary,
      };
    }
  },
});