import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';
import { db } from '../database/connection';
import { Wallet } from '../types';

const JUP_TOKENS_URL = 'https://token.jup.ag/all';
const JUP_PRICES_URL = 'https://price.jup.ag/v6/price';

type TokenInfo = { address: string; symbol: string; name?: string; decimals: number };

export class PortfolioService {
  private connection: Connection;
  private tokenListCache: { at: number; data: TokenInfo[] } | null = null;

  constructor(rpcUrl: string = 'https://api.mainnet-beta.solana.com') {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  private async getPrimaryWallet(userId: bigint): Promise<Wallet | null> {
    const w = await db.get<Wallet>(
      'SELECT * FROM wallets WHERE user_id = ? AND is_primary = true',
      [userId.toString()]
    );
    return (w as Wallet) || null;
  }

  private async fetchTokenList(): Promise<TokenInfo[]> {
    const now = Date.now();
    if (this.tokenListCache && now - this.tokenListCache.at < 5 * 60 * 1000) {
      return this.tokenListCache.data;
    }
    try {
      const { data } = await axios.get(JUP_TOKENS_URL, { timeout: 15000 });
      const list: TokenInfo[] = data;
      this.tokenListCache = { at: now, data: list };
      return list;
    } catch (e) {
      // Fallback to cache or empty list
      return this.tokenListCache?.data || [];
    }
  }

  private async resolveMintMeta(mint: string): Promise<TokenInfo | null> {
    const list = await this.fetchTokenList();
    const found = list.find(t => t.address === mint);
    return found || null;
  }

  async getPortfolio(userId: bigint): Promise<{
    address: string;
    sol: number;
    tokens: Array<{ mint: string; amount: number; symbol: string; decimals: number }>;
  }> {
    const primary = await this.getPrimaryWallet(userId);
    if (!primary) throw new Error('No primary wallet found');

    const owner = new PublicKey(primary.public_key);

    // SOL balance
    const lamports = await this.connection.getBalance(owner, 'confirmed');
    const sol = lamports / LAMPORTS_PER_SOL;

    // SPL tokens parsed
    const resp = await this.connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
    const accounts = resp.value || [];

    const tokens: Array<{ mint: string; amount: number; symbol: string; decimals: number }> = [];

    for (const { account } of accounts) {
      const data: any = account.data;
      const info = data?.parsed?.info;
      const mint: string | undefined = info?.mint;
      const tokenAmount = info?.tokenAmount;
      if (!mint || !tokenAmount) continue;
      const decimals: number = Number(tokenAmount?.decimals || 0);
      const uiAmount = typeof tokenAmount.uiAmount === 'number'
        ? tokenAmount.uiAmount
        : Number(tokenAmount.amount) / Math.pow(10, decimals);
      if (!uiAmount || uiAmount <= 0) continue;

      const meta = await this.resolveMintMeta(mint);
      const symbol = meta?.symbol || mint.slice(0,4) + '...' + mint.slice(-4);
      tokens.push({ mint, amount: uiAmount, symbol, decimals });
    }

    // sort by amount desc (rough)
    tokens.sort((a, b) => b.amount - a.amount);

    return { address: primary.public_key, sol, tokens };
  }

  private async getPrices(mints: string[], includeSOL = true): Promise<Record<string, number>> {
    const ids = [...new Set(mints)];
    const params: any = {};
    if (ids.length) params.ids = ids.join(',');
    const priceMap: Record<string, number> = {};
    try {
      const { data } = await axios.get(JUP_PRICES_URL, { params, timeout: 15000 });
      const byId = data?.data || {};
      for (const k of Object.keys(byId)) {
        const p = byId[k];
        if (p && typeof p.price === 'number') priceMap[k] = p.price;
      }
    } catch (e) {
      // Network issues (e.g., DNS). Return empty map and continue without USD.
    }
    // Try to fill SOL price if requested
    if (includeSOL) {
      try {
        const list = await this.fetchTokenList();
        const solMeta = list.find(t => t.symbol?.toUpperCase() === 'SOL');
        if (solMeta && !priceMap[solMeta.address]) {
          const solPriceRes = await axios.get(JUP_PRICES_URL, { params: { ids: 'SOL' }, timeout: 15000 });
          const solPrice = solPriceRes?.data?.data?.SOL?.price;
          if (typeof solPrice === 'number') priceMap[solMeta.address] = solPrice;
        }
      } catch {}
    }
    return priceMap;
  }

  async getPortfolioUSD(userId: bigint): Promise<{
    address: string;
    sol: number;
    solUSD: number;
    tokens: Array<{ mint: string; amount: number; symbol: string; decimals: number; usd?: number; price?: number }>;
    totalUSD: number;
  }> {
    const base = await this.getPortfolio(userId);
    const list = await this.fetchTokenList();
    const solMint = list.find(t => t.symbol?.toUpperCase() === 'SOL')?.address;
    const mints = [...new Set([...(base.tokens.map(t => t.mint)), solMint].filter(Boolean) as string[])];
    const prices = await this.getPrices(mints, true);

    const solPrice = solMint ? prices[solMint] : undefined;
    const solUSD = solPrice ? base.sol * solPrice : 0;

    const tokensWithUSD = base.tokens.map(t => {
      const price = prices[t.mint];
      const usd = price ? t.amount * price : undefined;
      return { ...t, price, usd };
    });

    const totalUSD = tokensWithUSD.reduce((acc, t) => acc + (t.usd || 0), solUSD);

    return { address: base.address, sol: base.sol, solUSD, tokens: tokensWithUSD, totalUSD };
  }

  async filterTokenBalance(userId: bigint, symbolOrMint: string): Promise<{ symbol: string; mint: string; amount: number; usd?: number; price?: number } | null> {
    const pf = await this.getPortfolioUSD(userId);
    // Match symbol first
    const foundBySymbol = pf.tokens.find(t => t.symbol?.toLowerCase() === symbolOrMint.toLowerCase());
    if (foundBySymbol) return { symbol: foundBySymbol.symbol, mint: foundBySymbol.mint, amount: foundBySymbol.amount, usd: foundBySymbol.usd, price: foundBySymbol.price };
    // Match by mint
    const foundByMint = pf.tokens.find(t => t.mint === symbolOrMint);
    if (foundByMint) return { symbol: foundByMint.symbol, mint: foundByMint.mint, amount: foundByMint.amount, usd: foundByMint.usd, price: foundByMint.price };
    // SOL special case
    if (symbolOrMint.toLowerCase() === 'sol') return { symbol: 'SOL', mint: 'SOL', amount: pf.sol, usd: pf.solUSD, price: pf.solUSD && pf.sol ? pf.solUSD / pf.sol : undefined } as any;
    return null;
  }
}
