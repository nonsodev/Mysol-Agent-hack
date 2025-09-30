import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchJupiterTokens } from "./jupiterUtils";
import { callLLM } from "../utils/callLLM"; // Adjust path if needed

const knownTokenDescriptions: Record<string, string> = {
  bonk: `BONK is one of Solana's most popular meme tokens. It was launched in December 2022 and quickly gained massive popularity in the Solana ecosystem. BONK was created as a community-driven project and was one of the first successful meme coins on Solana. It gained significant attention for its fair launch approach, where a large portion of the tokens were airdropped to the Solana community, including NFT collectors, creators, and developers.`
  // Add more tokens as needed
};

export const searchToken = createTool({
  id: "searchToken",
  description: `Search for a Solana token by name, symbol, or address using Jupiter's verified token list. `,
  inputSchema: z.object({
    query: z.string().min(1).describe("Token name, symbol, or address to search"),
  }),
  outputSchema: z.object({
    name: z.string(),
    symbol: z.string(),
    mintAddress: z.string(),
    logoURI: z.string().nullable(),
    dailyVolume: z.string().nullable(),
    summary: z.string(),
  }),
  execute: async (args) => {
    const query =
      args.input?.query ||
      args.query ||
      args.context?.query ||
      (typeof args === "string" ? args : "") ||
      "";

    const results = await searchJupiterTokens(query);

    if (!results.length) {
      return {
        name: "",
        symbol: "",
        mintAddress: "",
        logoURI: null,
        dailyVolume: null,
        summary: "No token found matching your query.",
      };
    }

    const token = results[0];
    const dailyVolume = token.daily_volume
      ? `$${Number(token.daily_volume).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : null;

    // Use known description or generate with LLM (plain, single paragraph, no formatting)
    let description =
      knownTokenDescriptions[token.symbol.toLowerCase()] || null;

    if (!description) {
      const prompt = `Write a short, friendly, one-paragraph description for the Solana token "${token.name}" (symbol: ${token.symbol}). 
Do NOT include any Markdown formatting, headings, or extra lines—just a single paragraph of plain text.
Here is some metadata:
- Mint address: ${token.address}
- Tags: ${token.tags ? token.tags.join(", ") : "none"}
- 24h Volume: ${dailyVolume || "unknown"}
- This is an SPL token on Solana.
Focus on what makes this token unique or notable, if possible.`;
      description = await callLLM(prompt);
      // Optionally, trim and sanitize the LLM output
      if (typeof description === "string") {
        description = description.trim().replace(/[\r\n]+/g, " ");
      }
    }

    const summary = `
**${token.name} (${token.symbol})**

**Mint Address:** \`${token.address}\`

${description ? `> ${description}\n` : ""}

**Type:** SPL Token (Solana)  
**Symbol:** ${token.symbol}  
**24h Volume:** ${dailyVolume || "N/A"}  

**View on Solscan:** https://solscan.io/token/${token.address}

${token.logoURI ? `**Logo:** ${token.logoURI}` : ""}

---

Would you like to:
- Get current price information for **${token.symbol}**?
- Swap tokens for **${token.symbol}**?
- Learn about specific metrics like volume or market cap?

_Just let me know what specific information you'd like to know about **${token.symbol}**._
`.trim();

    return {
      name: token.name,
      symbol: token.symbol,
      mintAddress: token.address,
      logoURI: token.logoURI ?? null,
      dailyVolume,
      summary,
    };
  },
});