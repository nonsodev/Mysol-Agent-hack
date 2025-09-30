import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchJupiterTokens } from "./jupiterUtils";
import axios from "axios";

// Known token descriptions (add more as needed)
const knownTokenDescriptions: Record<string, string> = {
  bonk: `BONK is one of Solana's most popular meme tokens. It was launched in December 2022 and quickly gained massive popularity in the Solana ecosystem. BONK was created as a community-driven project and was one of the first successful meme coins on Solana. It gained significant attention for its fair launch approach, where a large portion of the tokens were airdropped to the Solana community, including NFT collectors, creators, and developers.`
};

export const tokenInfo = createTool({
  id: "tokenInfo",
  description: "Get a full profile for a Solana token: summary, price, liquidity, market cap, socials, and more.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Token name, symbol, or address to search"),
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
  execute: async (args) => {
    const query =
      args.input?.query ||
      args.query ||
      args.context?.query ||
      (typeof args === "string" ? args : "") ||
      "";

    // 1. Search Jupiter
    const results = await searchJupiterTokens(query);

    if (!results.length) {
      return {
        name: "",
        symbol: "",
        mintAddress: "",
        logoURI: null,
        dailyVolume: null,
        priceUsd: null,
        liquidityUsd: null,
        marketCap: null,
        fdv: null,
        volume24h: null,
        priceChange: { h24: null, h6: null, h1: null, m5: null },
        txns: { buy: null, sell: null, total: null },
        socials: { website: null, twitter: null, telegram: null, discord: null },
        dexScreenerUrl: null,
        summary: "No token found matching your query.",
      };
    }

    const token = results[0];
    const dailyVolume = token.daily_volume
      ? `$${Number(token.daily_volume).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : null;

    // 2. Get description (NO LLM)
    let description =
      knownTokenDescriptions[token.symbol.toLowerCase()] || "";

    // 3. Fetch DexScreener profile
    let priceUsd = null, liquidityUsd = null, marketCap = null, fdv = null, volume24h = null;
    let priceChange = { h24: null, h6: null, h1: null, m5: null };
    let txns = { buy: null, sell: null, total: null };
    let socials = { website: null, twitter: null, telegram: null, discord: null };
    let dexScreenerUrl = null;

    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${token.address}`;
      const { data } = await axios.get(url);

      if (data.pairs && data.pairs.length) {
        const bestPair = data.pairs.reduce((a, b) =>
          (a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b
        );

        priceUsd = bestPair.priceUsd ? `$${Number(bestPair.priceUsd).toLocaleString(undefined, { maximumFractionDigits: 8 })}` : null;
        liquidityUsd = bestPair.liquidity?.usd ? `$${Number(bestPair.liquidity.usd).toLocaleString()}` : null;
        marketCap = bestPair.fdv ? `$${Number(bestPair.fdv).toLocaleString()}` : null;
        fdv = bestPair.fdv ? `$${Number(bestPair.fdv).toLocaleString()}` : null;
        volume24h = bestPair.volume?.h24 ? `$${Number(bestPair.volume.h24).toLocaleString()}` : null;

        // --- FIXED SOCIALS EXTRACTION ---
        const info = bestPair.info || {};

        // Website: prefer label "Website", else first url
        let website = null;
        if (Array.isArray(info.websites)) {
          const site = info.websites.find(w => w.label?.toLowerCase() === "website") || info.websites[0];
          website = site?.url || null;
        }

        // Socials: extract by type
        let twitter = null, telegram = null, discord = null;
        if (Array.isArray(info.socials)) {
          for (const s of info.socials) {
            if (s.type === "twitter") twitter = s.url;
            if (s.type === "telegram") telegram = s.url;
            if (s.type === "discord") discord = s.url;
          }
        }

        socials = { website, twitter, telegram, discord };
        // --- END FIX ---

        priceChange = {
          h24: bestPair.priceChange?.h24 ? `${bestPair.priceChange.h24}%` : null,
          h6: bestPair.priceChange?.h6 ? `${bestPair.priceChange.h6}%` : null,
          h1: bestPair.priceChange?.h1 ? `${bestPair.priceChange.h1}%` : null,
          m5: bestPair.priceChange?.m5 ? `${bestPair.priceChange.m5}%` : null,
        };

        txns = {
          buy: bestPair.txns?.h24?.buys?.toString() || null,
          sell: bestPair.txns?.h24?.sells?.toString() || null,
          total: bestPair.txns?.h24?.total?.toString() || null,
        };

        dexScreenerUrl = `https://dexscreener.com/solana/${bestPair.pairAddress}`;
      }
    } catch (e) {
      // DexScreener may not have data for every token; that's OK
    }

    // 4. Compose summary
    const summary = `
### ${token.name} (${token.symbol})

**Mint Address:** \`${token.address}\n\`

${description ? `> ${description}\n` : ""}

${dexScreenerUrl ? `[View on DexScreener](${dexScreenerUrl})\n` : ""}

---

#### 🪙 **Quick Facts**
- **Price:** ${priceUsd || "N/A"}
- **Liquidity:** ${liquidityUsd || "N/A"}
- **Market Cap:** ${marketCap || "N/A"}
- **FDV:** ${fdv || "N/A"}
- **24h Volume:** ${volume24h || "N/A"}

---

#### 📈 **Price Change**
| 24h | 6h | 1h | 5m |
|-----|----|----|----|
| ${priceChange.h24 || "N/A"} | ${priceChange.h6 || "N/A"} | ${priceChange.h1 || "N/A"} | ${priceChange.m5 || "N/A"} |

---

#### 🔄 **Trading Activity (24h)**
| Buys | Sells |
|------|-------|
| ${txns.buy || "N/A"} | ${txns.sell || "N/A"} |

---

#### 🌐 **Social Links**
${socials.website ? `- [Website](${socials.website})` : "- Website: N/A"}
${socials.twitter ? `\n- [Twitter](${socials.twitter})` : "\n- Twitter: N/A"}
${socials.telegram ? `\n- [Telegram](${socials.telegram})` : "\n- Telegram: N/A"}
${socials.discord ? `\n- [Discord](${socials.discord})` : "\n- Discord: N/A"}

`.trim();

    return {
      name: token.name,
      symbol: token.symbol,
      mintAddress: token.address,
      logoURI: token.logoURI ?? null,
      dailyVolume,
      priceUsd,
      liquidityUsd,
      marketCap,
      fdv,
      volume24h,
      priceChange,
      txns,
      socials,
      dexScreenerUrl,
      summary,
    };
  },
});