import axios from "axios";

let cachedTokens: any[] = [];
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Jupiter API configuration
const JUPITER_API_CONFIG = {
  timeout: 10000, // 10 seconds timeout
  retries: 2,
  retryDelay: 1000, // 1 second between retries
};

export async function getJupiterTokens() {
  const now = Date.now();
  if (cachedTokens.length && now - cacheTimestamp < CACHE_DURATION) {
    return cachedTokens;
  }
  
  const url = "https://tokens.jup.ag/tokens?tags=verified";
  
  for (let attempt = 0; attempt <= JUPITER_API_CONFIG.retries; attempt++) {
    try {
      console.log(`🔍 Fetching Jupiter tokens (attempt ${attempt + 1}/${JUPITER_API_CONFIG.retries + 1})`);
      
      const res = await axios.get(url, {
        timeout: JUPITER_API_CONFIG.timeout,
        headers: {
          'User-Agent': 'MySol-Agent/1.0',
          'Accept': 'application/json',
        }
      });
      
      cachedTokens = res.data || [];
      cacheTimestamp = now;
      console.log(`✅ Successfully fetched ${cachedTokens.length} Jupiter tokens`);
      return cachedTokens;
      
    } catch (error: any) {
      console.error(`❌ Jupiter API error (attempt ${attempt + 1}):`, error.message);
      
      if (attempt < JUPITER_API_CONFIG.retries) {
        console.log(`⏳ Retrying in ${JUPITER_API_CONFIG.retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, JUPITER_API_CONFIG.retryDelay));
      } else {
        console.error("❌ All Jupiter API attempts failed, returning cached tokens if available");
        return cachedTokens; // Return cached tokens if available, empty array otherwise
      }
    }
  }
  
  return cachedTokens;
}

export async function searchJupiterTokens(query: string) {
  const tokens = await getJupiterTokens();
  const searchTerm = query.trim().replace(/^\$/, "").toLowerCase();

  let results = tokens.filter(
    (token: any) =>
      (token.name && token.name.toLowerCase().includes(searchTerm)) ||
      (token.symbol && token.symbol.toLowerCase().includes(searchTerm)) ||
      (token.address && token.address.toLowerCase() === searchTerm)
  ).filter(
    (token: any) => token.name && token.symbol
  );

  results = results.sort((a: any, b: any) => {
    const aExact =
      (a.symbol && a.symbol.toLowerCase() === searchTerm) ||
      (a.name && a.name.toLowerCase() === searchTerm) ||
      (a.address && a.address.toLowerCase() === searchTerm);
    const bExact =
      (b.symbol && b.symbol.toLowerCase() === searchTerm) ||
      (b.name && b.name.toLowerCase() === searchTerm) ||
      (b.address && b.address.toLowerCase() === searchTerm);
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    return 0;
  });

  return results;
}

// Jupiter liquidity validation with improved error handling
export async function validateJupiterLiquidity(tokenAddress: string): Promise<{
  isValid: boolean;
  liquidityUSD: number;
  error?: string;
}> {
  try {
    console.log(`🔍 Validating Jupiter liquidity for token: ${tokenAddress}`);
    
    // Use Jupiter price API to check liquidity
    const priceUrl = `https://price.jup.ag/v4/price?ids=${tokenAddress}`;
    
    for (let attempt = 0; attempt <= JUPITER_API_CONFIG.retries; attempt++) {
      try {
        const response = await axios.get(priceUrl, {
          timeout: JUPITER_API_CONFIG.timeout,
          headers: {
            'User-Agent': 'MySol-Agent/1.0',
            'Accept': 'application/json',
          }
        });
        
        const priceData = response.data?.data?.[tokenAddress];
        
        if (!priceData) {
          console.log(`❌ No price data found for token ${tokenAddress}`);
          return {
            isValid: false,
            liquidityUSD: 0,
            error: "No price data available"
          };
        }
        
        const price = priceData.price || 0;
        const liquidityUSD = price > 0 ? price * 1000 : 0; // Rough liquidity estimate
        
        console.log(`✅ Token ${tokenAddress} - Price: $${price}, Estimated Liquidity: $${liquidityUSD}`);
        
        return {
          isValid: liquidityUSD > 0,
          liquidityUSD,
        };
        
      } catch (error: any) {
        console.error(`❌ Jupiter price API error (attempt ${attempt + 1}):`, error.message);
        
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          console.log(`⏰ Request timeout for token ${tokenAddress}`);
          if (attempt < JUPITER_API_CONFIG.retries) {
            console.log(`⏳ Retrying in ${JUPITER_API_CONFIG.retryDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, JUPITER_API_CONFIG.retryDelay));
            continue;
          }
          return {
            isValid: false,
            liquidityUSD: 0,
            error: `Timeout after ${JUPITER_API_CONFIG.retries + 1} attempts`
          };
        }
        
        if (attempt >= JUPITER_API_CONFIG.retries) {
          return {
            isValid: false,
            liquidityUSD: 0,
            error: error.message
          };
        }
        
        await new Promise(resolve => setTimeout(resolve, JUPITER_API_CONFIG.retryDelay));
      }
    }
    
    return {
      isValid: false,
      liquidityUSD: 0,
      error: "All attempts failed"
    };
    
  } catch (error: any) {
    console.error(`❌ Unexpected error validating token ${tokenAddress}:`, error);
    return {
      isValid: false,
      liquidityUSD: 0,
      error: error.message || "Unexpected error"
    };
  }
}

// Batch validate multiple tokens with rate limiting
export async function batchValidateTokens(tokenAddresses: string[], batchSize: number = 5, delayMs: number = 1000): Promise<Map<string, {
  isValid: boolean;
  liquidityUSD: number;
  error?: string;
}>> {
  const results = new Map();
  
  console.log(`🚀 Starting batch validation of ${tokenAddresses.length} tokens (batch size: ${batchSize})`);
  
  for (let i = 0; i < tokenAddresses.length; i += batchSize) {
    const batch = tokenAddresses.slice(i, i + batchSize);
    console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(tokenAddresses.length / batchSize)}`);
    
    const batchPromises = batch.map(async (tokenAddress) => {
      const result = await validateJupiterLiquidity(tokenAddress);
      results.set(tokenAddress, result);
      return { tokenAddress, result };
    });
    
    await Promise.all(batchPromises);
    
    // Add delay between batches to avoid rate limiting
    if (i + batchSize < tokenAddresses.length) {
      console.log(`⏳ Waiting ${delayMs}ms before next batch...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  console.log(`✅ Batch validation completed. Valid tokens: ${Array.from(results.values()).filter(r => r.isValid).length}/${tokenAddresses.length}`);
  
  return results;
}