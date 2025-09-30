import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import { db } from '../database/connection';
import { Wallet } from '../types';
import { WalletEncryption, EncryptedWallet } from '../utils/wallet-encryptor';

const JUP_TOKENS_URL = 'https://token.jup.ag/all';
const JUP_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN_FEE_SOL = 0.0005; // conservative minimum to cover fees

export class SwapService {
  private connection: Connection;

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

  private async getPrivateKey(walletId: string, userId: bigint): Promise<Uint8Array | null> {
    const wallet = await db.get<Wallet>('SELECT * FROM wallets WHERE id = ? AND user_id = ?', [walletId, userId.toString()]);
    if (!wallet) return null;
    const enc: EncryptedWallet = {
      encryptedPrivateKey: (wallet as any).encrypted_private_key,
      iv: (wallet as any).iv,
      salt: (wallet as any).salt,
      tag: (wallet as any).tag,
    };
    const hex = WalletEncryption.decryptPrivateKey(enc);
    return new Uint8Array(Buffer.from(hex, 'hex'));
  }

  private async resolveOutputMint(symbolOrMint: string): Promise<string> {
    // If it looks like a mint, return as-is
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(symbolOrMint)) return symbolOrMint;
    // Else fetch list and match by symbol
    const { data } = await axios.get(JUP_TOKENS_URL, { timeout: 15000 });
    const list: Array<{ address: string; symbol: string }> = data;
    const found = list.find(t => t.symbol?.toLowerCase() === symbolOrMint.toLowerCase());
    if (!found) throw new Error(`Token not found for symbol: ${symbolOrMint}`);
    return found.address;
  }

  private async resolveTokenInfo(symbolOrMint: string): Promise<{ address: string; decimals: number; symbol: string }>{
    // If it's a mint, try to find it directly; otherwise match by symbol
    const { data } = await axios.get(JUP_TOKENS_URL, { timeout: 15000 });
    const list: Array<{ address: string; symbol: string; decimals: number }> = data;
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(symbolOrMint)) {
      const foundByMint = list.find(t => t.address === symbolOrMint);
      if (!foundByMint) throw new Error(`Token not found for mint: ${symbolOrMint}`);
      return { address: foundByMint.address, decimals: foundByMint.decimals, symbol: foundByMint.symbol };
    }
    const foundBySymbol = list.find(t => t.symbol?.toLowerCase() === symbolOrMint.toLowerCase());
    if (!foundBySymbol) throw new Error(`Token not found for symbol: ${symbolOrMint}`);
    return { address: foundBySymbol.address, decimals: foundBySymbol.decimals, symbol: foundBySymbol.symbol };
  }

  async swapSolToToken(userId: bigint, amountSOL: number, outputToken: string, slippageBps = 100): Promise<{ signature: string }>{
    if (!amountSOL || amountSOL <= 0) throw new Error('Amount must be > 0');

    const primary = await this.getPrimaryWallet(userId);
    if (!primary) throw new Error('No primary wallet found');

    const secret = await this.getPrivateKey(primary.id, userId);
    if (!secret) throw new Error('Unable to decrypt private key');

    const owner = Keypair.fromSecretKey(secret);
    const ownerPk = owner.publicKey.toBase58();

    const outputMint = await this.resolveOutputMint(outputToken);
    const amount = Math.floor(amountSOL * LAMPORTS_PER_SOL);

    // Preflight: ensure enough SOL to cover amount + fees
    const lamports = await this.connection.getBalance(owner.publicKey, 'processed');
    const minFeeLamports = Math.ceil(MIN_FEE_SOL * LAMPORTS_PER_SOL);
    if (lamports < amount + minFeeLamports) {
      const haveSol = lamports / LAMPORTS_PER_SOL;
      const needSol = amountSOL + MIN_FEE_SOL;
      throw new Error(`Insufficient SOL to cover amount + fees. Have ${haveSol.toFixed(9)} SOL, need at least ~${needSol.toFixed(6)} SOL.`);
    }

    // 1) Get quote
    const quoteParams = {
      inputMint: SOL_MINT,
      outputMint,
      amount,
      slippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    } as any;

    const quoteRes = await axios.get(JUP_QUOTE_URL, { params: quoteParams, timeout: 20000 });
    const quote = quoteRes.data;
    if (!quote || !quote.routePlan) throw new Error('No route found for the swap');

    // 2) Get swap transaction
    const swapRes = await axios.post(JUP_SWAP_URL, {
      quoteResponse: quote,
      userPublicKey: ownerPk,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: { maxBps: slippageBps },
      prioritizationFeeLamports: 'auto',
    }, { timeout: 20000 });

    const swapData = swapRes.data;
    const swapTxBase64: string = swapData.swapTransaction;
    if (!swapTxBase64) throw new Error('Invalid swap response from Jupiter');

    // 3) Deserialize, sign, simulate, and send
    const txBuf = Buffer.from(swapTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([owner]);
    // Simulate for better diagnostics
    const sim = await this.connection.simulateTransaction(tx, { commitment: 'processed' });
    if (sim.value.err) {
      const logs = sim.value.logs?.join('\n') || 'No logs';
      throw new Error(`Simulation failed before send. Logs:\n${logs}`);
    }
    const sig = await this.connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await this.connection.confirmTransaction(sig, 'confirmed');

    return { signature: sig };
  }

  async swapTokenToToken(
    userId: bigint,
    amount: number,
    inputToken: string,
    outputToken: string,
    slippageBps = 100
  ): Promise<{ signature: string }>{
    if (!amount || amount <= 0) throw new Error('Amount must be > 0');

    const primary = await this.getPrimaryWallet(userId);
    if (!primary) throw new Error('No primary wallet found');

    const secret = await this.getPrivateKey(primary.id, userId);
    if (!secret) throw new Error('Unable to decrypt private key');

    const owner = Keypair.fromSecretKey(secret);
    const ownerPk = owner.publicKey.toBase58();

    // Resolve input/output token info
    const inInfo = inputToken.toLowerCase() === 'sol'
      ? { address: SOL_MINT, decimals: 9, symbol: 'SOL' }
      : await this.resolveTokenInfo(inputToken);
    const outInfo = await this.resolveTokenInfo(outputToken);

    const amountIn = BigInt(Math.floor(amount * 10 ** inInfo.decimals));

    // Preflight: ensure sufficient input balance when not SOL
    if (inInfo.address !== SOL_MINT) {
      const ownerPkKey = new PublicKey(ownerPk);
      const parsed = await this.connection.getParsedTokenAccountsByOwner(ownerPkKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
      const acct = parsed.value.find(v => (v.account.data as any)?.parsed?.info?.mint === inInfo.address);
      const tokAmt = (acct?.account.data as any)?.parsed?.info?.tokenAmount;
      const uiBal = tokAmt?.uiAmount as number | undefined;
      if (!uiBal || uiBal < amount) {
        throw new Error(`Insufficient ${inInfo.symbol} balance. You have ${uiBal ?? 0}, need ${amount}.`);
      }
    }

    // 1) Get quote
    const quoteParams = {
      inputMint: inInfo.address,
      outputMint: outInfo.address,
      amount: amountIn.toString(),
      slippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    } as any;

    const quoteRes = await axios.get(JUP_QUOTE_URL, { params: quoteParams, timeout: 20000 });
    const quote = quoteRes.data;
    if (!quote || !quote.routePlan) throw new Error('No route found for the swap');

    // 2) Get swap transaction
    const swapRes = await axios.post(JUP_SWAP_URL, {
      quoteResponse: quote,
      userPublicKey: ownerPk,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: { maxBps: slippageBps },
      prioritizationFeeLamports: 'auto',
    }, { timeout: 20000 });

    const swapData = swapRes.data;
    const swapTxBase64: string = swapData.swapTransaction;
    if (!swapTxBase64) throw new Error('Invalid swap response from Jupiter');

    // 3) Deserialize, sign, simulate, and send
    const txBuf = Buffer.from(swapTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([owner]);
    // Simulate for better diagnostics
    const sim = await this.connection.simulateTransaction(tx, { commitment: 'processed' });
    if (sim.value.err) {
      const logs = sim.value.logs?.join('\n') || 'No logs';
      throw new Error(`Simulation failed before send. Logs:\n${logs}`);
    }
    const sig = await this.connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await this.connection.confirmTransaction(sig, 'confirmed');

    return { signature: sig };
  }
}
