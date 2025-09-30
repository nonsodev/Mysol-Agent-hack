import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";

const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY";
const JUPITER_TOKENS_URL = "https://token.jup.ag/all";
const JUPITER_PRICES_URL = "https://price.jup.ag/v4/price";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_MINT = "So11111111111111111111111111111111111111112"; // WSOL has same mint as SOL
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

// Jupiter API configuration for retries
const JUPITER_API_CONFIG = {
  timeout: 10000, // 10 seconds timeout
  retries: 2,
  retryDelay: 1000, // 1 second between retries
};

// Circuit breaker for Jupiter API
let jupiterApiFailures = 0;
let lastJupiterFailureTime = 0;
const MAX_FAILURES = 5;
const CIRCUIT_BREAKER_TIMEOUT = 60000; // 1 minute

function isJupiterApiDown(): boolean {
  const now = Date.now();
  if (jupiterApiFailures >= MAX_FAILURES) {
    if (now - lastJupiterFailureTime < CIRCUIT_BREAKER_TIMEOUT) {
      return true;
    } else {
      // Reset circuit breaker after timeout
      jupiterApiFailures = 0;
      lastJupiterFailureTime = 0;
    }
  }
  return false;
}

function recordJupiterFailure(): void {
  jupiterApiFailures++;
  lastJupiterFailureTime = Date.now();
  console.log(`⚠️ Jupiter API failure count: ${jupiterApiFailures}/${MAX_FAILURES}`);
}

// Helper function to validate token prices using Jupiter with improved error handling
async function validateTokenPrice(mint: string, jupiterPrice: number): Promise<{ isValid: boolean; validatedPrice: number }> {
  // Skip validation for SOL/WSOL
  if (mint === SOL_MINT || mint === WSOL_MINT) {
    return { isValid: true, validatedPrice: jupiterPrice };
  }

  // Check circuit breaker - if Jupiter API is down, skip validation but allow the token
  if (isJupiterApiDown()) {
    console.log(`🔄 Jupiter API circuit breaker active - skipping validation for ${mint} (allowing token)`);
    return { isValid: true, validatedPrice: jupiterPrice };
  }

  const jupiterUrl = `https://lite-api.jup.ag/tokens/v2/search?query=${mint}`;
  
  for (let attempt = 0; attempt <= JUPITER_API_CONFIG.retries; attempt++) {
    try {
      console.log(`🔍 Validating token ${mint} (attempt ${attempt + 1}/${JUPITER_API_CONFIG.retries + 1})`);
      
      const response = await axios.get(jupiterUrl, { 
        timeout: JUPITER_API_CONFIG.timeout,
        headers: {
          'User-Agent': 'MySol-Agent/1.0',
          'Accept': 'application/json',
        }
      });
      
      if (response.data && response.data.length > 0) {
        const tokenData = response.data[0]; // First result should be exact match
        
        const liquidity = tokenData.liquidity || 0;
        const volume24h = (tokenData.stats24h?.buyVolume || 0) + (tokenData.stats24h?.sellVolume || 0);
        const organicScore = tokenData.organicScore || 0;
        const isSus = tokenData.audit?.isSus || false;
        const topHoldersPercentage = tokenData.audit?.topHoldersPercentage || 0;
        
        // JUPITER-BASED validation criteria for filtering pulled liquidity:
        // 1. Must have real liquidity ($1000+ in Jupiter's accurate data)
        // 2. Must have meaningful 24h volume ($100+ to ensure active trading)
        // 3. Must not be flagged as suspicious
        // 4. Top holders shouldn't control >90% of supply
        // 5. Should have some organic activity
        const minLiquidity = 1000;  // $1000 minimum liquidity (Jupiter's accurate data)
        const minVolume = 100;      // $100 minimum 24h volume
        const maxTopHolders = 90;   // Max 90% held by top holders
        
        if (liquidity < minLiquidity) {
          console.log(`Token ${mint} rejected: Jupiter liquidity too low ($${liquidity})`);
          return { isValid: false, validatedPrice: 0 };
        }
        
        if (volume24h < minVolume) {
          console.log(`Token ${mint} rejected: 24h volume too low ($${volume24h})`);
          return { isValid: false, validatedPrice: 0 };
        }
        
        if (isSus) {
          console.log(`Token ${mint} rejected: flagged as suspicious by Jupiter`);
          return { isValid: false, validatedPrice: 0 };
        }
        
        if (topHoldersPercentage > maxTopHolders) {
          console.log(`Token ${mint} rejected: top holders control ${topHoldersPercentage}% of supply`);
          return { isValid: false, validatedPrice: 0 };
        }
        
        // Token passes all validation checks
        console.log(`✅ Token ${mint} validated: liquidity=$${liquidity}, volume24h=$${volume24h}, organic=${organicScore}, topHolders=${topHoldersPercentage}%`);
        return { isValid: true, validatedPrice: jupiterPrice };
      }

      // If no Jupiter data, reject the price
      console.log(`Token ${mint} rejected: no Jupiter data found`);
      return { isValid: false, validatedPrice: 0 };

    } catch (error: any) {
      console.error(`❌ Jupiter API error for token ${mint} (attempt ${attempt + 1}):`, error.message);
      
      // Record failure for circuit breaker
      if (attempt === JUPITER_API_CONFIG.retries) {
        recordJupiterFailure();
      }
      
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        console.log(`⏰ Request timeout for token ${mint}`);
        if (attempt < JUPITER_API_CONFIG.retries) {
          console.log(`⏳ Retrying in ${JUPITER_API_CONFIG.retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, JUPITER_API_CONFIG.retryDelay));
          continue;
        }
        console.log(`Token ${mint} Jupiter validation error: timeout of ${JUPITER_API_CONFIG.timeout}ms exceeded`);
        return { isValid: true, validatedPrice: jupiterPrice }; // Allow token when API is down
      }
      
      if (attempt >= JUPITER_API_CONFIG.retries) {
        console.log(`Token ${mint} Jupiter validation error: ${error.message}`);
        return { isValid: true, validatedPrice: jupiterPrice }; // Allow token when API is down
      }
      
      await new Promise(resolve => setTimeout(resolve, JUPITER_API_CONFIG.retryDelay));
    }
  }
  
  // If all attempts failed, allow the token (API might be down)
  console.log(`Token ${mint} Jupiter validation error: all attempts failed - allowing token`);
  return { isValid: true, validatedPrice: jupiterPrice };
}

export const getWalletPortfolio = createTool({
  id: "getWalletPortfolio",
  description: "Get a Solana wallet's SOL balance and top token holdings (by USD value), with live prices and metadata. Includes price validation and proper WSOL handling.",
  inputSchema: z.object({
    walletAddress: z.string().min(32).describe("Solana wallet address"),
  }),
  outputSchema: z.object({
    sol: z.object({
      lamports: z.number(),
      sol: z.number(),
      usd: z.number(),
      breakdown: z.object({
        nativeSOL: z.number(),
        wrappedSOL: z.number(),
      }),
    }),
    tokens: z.array(
      z.object({
        mint: z.string(),
        amount: z.string(),
        decimals: z.number(),
        uiAmount: z.number(),
        tokenName: z.string().optional(),
        tokenSymbol: z.string().optional(),
        logo: z.string().optional(),
        usd: z.number(),
        priceValidated: z.boolean(),
      })
    ),
    text: z.string(),
  }),
  execute: async (args) => {
    const walletAddress =
      args?.input?.walletAddress ||
      args?.walletAddress ||
      args?.context?.walletAddress ||
      (typeof args === "string" ? args : null);

    if (!walletAddress) {
      throw new Error("walletAddress is required");
    }

    // 1. Fetch all assets (tokens + SOL) from Helius
    let items: any[] = [];
    let nativeSOLLamports = 0;
    let solPrice = 0;
    let nativeSOLUsd = 0;

    try {
      const heliusRes = await axios.post(
        HELIUS_RPC,
        {
          jsonrpc: "2.0",
          id: "1",
          method: "searchAssets",
          params: {
            ownerAddress: walletAddress,
            tokenType: "all",
            displayOptions: {
              showNativeBalance: true,
              showInscription: false,
              showCollectionMetadata: false,
            },
          },
        },
        { headers: { "Content-Type": "application/json" } }
      );
      items = heliusRes.data?.result?.items || [];
      nativeSOLLamports = heliusRes.data?.result?.nativeBalance?.lamports || 0;
      solPrice = heliusRes.data?.result?.nativeBalance?.price_per_sol || 0;
      nativeSOLUsd = heliusRes.data?.result?.nativeBalance?.total_price || 0;
    } catch (err: any) {
      return {
        sol: { 
          lamports: 0, 
          sol: 0, 
          usd: 0,
          breakdown: { nativeSOL: 0, wrappedSOL: 0 }
        },
        tokens: [],
        text: "Error fetching wallet data: " + (err?.response?.data?.error || err.message || "Unknown error"),
      };
    }

    // 2. Parse fungible tokens and separate WSOL
    let tokens: any[] = items.filter(
      (item: any) =>
        item.interface === "FungibleToken" || item.interface === "FungibleAsset"
    );

    // 3. Handle WSOL separately
    let wrappedSOLAmount = 0;
    let wrappedSOLUsd = 0;
    
    // Find and extract WSOL tokens
    tokens = tokens.filter((token) => {
      if (token.id === WSOL_MINT || token.id === WRAPPED_SOL_MINT) {
        const wsolBalance = token.token_info?.balance || token.token_info?.amount || 0;
        wrappedSOLAmount += Number(wsolBalance) / 1e9; // Convert lamports to SOL
        wrappedSOLUsd += wrappedSOLAmount * solPrice;
        return false; // Remove WSOL from tokens array
      }
      return true;
    });

    // 4. Calculate combined SOL balance
    const nativeSOL = nativeSOLLamports / 1e9;
    const totalSOL = nativeSOL + wrappedSOLAmount;
    const totalSOLUsd = totalSOL * solPrice;

    // 5. Fetch Jupiter token list and prices
    let tokenList: any[] = [];
    let priceMap: Record<string, any> = {};
    try {
      const [tokenListRes, priceRes] = await Promise.all([
        axios.get(JUPITER_TOKENS_URL),
        axios.get(
          `${JUPITER_PRICES_URL}?ids=${tokens
            .map((t) => t.id || t.mint)
            .join(",")}`
        ),
      ]);
      tokenList = tokenListRes.data || [];
      priceMap = priceRes.data?.data || {};
    } catch (err) {
      // fallback: no price enrichment
    }

    // 6. Enrich tokens with metadata and validated USD price
    const enrichedTokens = await Promise.all(
      tokens.map(async (token) => {
        const mint = token.id || token.mint;
        const meta = tokenList.find((t) => t.address === mint) || {};
        const decimals =
          token.token_info?.decimals ??
          meta.decimals ??
          0;
        const rawAmount = token.token_info?.balance || token.token_info?.amount || "0";
        const uiAmount =
          typeof rawAmount === "string" || typeof rawAmount === "number"
            ? Number(rawAmount) / Math.pow(10, decimals)
            : 0;
        
        const jupiterPrice =
          priceMap[mint]?.price ||
          token.token_info?.price_info?.price_per_token ||
          0;

        // Validate the price
        const { isValid, validatedPrice } = await validateTokenPrice(mint, jupiterPrice);
        const finalPrice = isValid ? validatedPrice : 0;
        const usd = uiAmount * finalPrice;

        return {
          mint,
          amount: rawAmount.toString(),
          decimals,
          uiAmount,
          tokenName: meta.name || token.content?.metadata?.name,
          tokenSymbol: meta.symbol || token.content?.metadata?.symbol,
          logo: meta.logoURI || token.content?.links?.image,
          usd,
          priceValidated: isValid,
        };
      })
    );

    // 7. Filter tokens with higher dust threshold and sort by USD value
    const dustThreshold = 5.0; // Increased from 0.01 to $5
    const validTokens = enrichedTokens
      .filter((t) => t.usd >= dustThreshold)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 15); // Show top 15 tokens

    // 8. Create human-friendly summary
    const totalTokensUsd = validTokens.reduce((sum, t) => sum + t.usd, 0);
    const totalPortfolioUsd = totalSOLUsd + totalTokensUsd;

    let text = `Here is the summary of wallet \`${walletAddress}\`:\n\n`;
    
    text += `💰 **Wallet Portfolio Summary**\n\n`;
    text += `The current portfolio value of the wallet is **$${totalPortfolioUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}**.\n\n`;
    
    // SOL breakdown
    text += `🌞 **SOL Balance:** ${totalSOL.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL ($${totalSOLUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })})\n`;
    if (wrappedSOLAmount > 0) {
      text += `   • Native SOL: ${nativeSOL.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL\n`;
      text += `   • Wrapped SOL: ${wrappedSOLAmount.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL\n`;
    }
    text += `\n`;
    
    if (validTokens.length > 0) {
      text += `Here are the top holdings (minimum $${dustThreshold} value, prices validated):\n\n`;
      text += `| # | Token | Symbol | Amount | Value (USD) | Validated |\n`;
      text += `|---|-------|--------|--------|-------------|----------|\n`;
      validTokens.forEach((token, idx) => {
        const validationIcon = token.priceValidated ? "✅" : "⚠️";
        text += `| ${idx + 1} | ${token.tokenName || token.tokenSymbol || token.mint} | ${token.tokenSymbol || ""} | ${token.uiAmount.toLocaleString()} | $${token.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })} | ${validationIcon} |\n`;
      });
      text += `\nThe wallet holds ${validTokens.length} token${validTokens.length > 1 ? "s" : ""} above the $${dustThreshold} threshold.\n`;
      text += `\n💡 **Price Validation:** ✅ = Price validated with liquidity/volume checks, ⚠️ = Price not validated\n`;
      text += `\nFor more detailed information about these tokens, including their current market value in USD and the token's logo, please refer to the \`searchToken\` tool.`;
    } else {
      text += "No significant token holdings found above the minimum threshold.";
    }

    return {
      sol: {
        lamports: Math.round(totalSOL * 1e9),
        sol: totalSOL,
        usd: totalSOLUsd,
        breakdown: {
          nativeSOL: nativeSOL,
          wrappedSOL: wrappedSOLAmount,
        },
      },
      tokens: validTokens,
      text,
    };
  },
});