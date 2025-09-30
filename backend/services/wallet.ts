import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL, SystemProgram, Transaction as SolanaTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { db } from '../database/connection';
import { Wallet, WalletCreationResult, Transaction } from '../types';
import { WalletEncryption, EncryptedWallet } from '../utils/wallet-encryptor';
import crypto from 'crypto';

export class WalletService {
  private connection: Connection;

  constructor(rpcUrl: string = 'https://api.mainnet-beta.solana.com') {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  /**
   * Creates a new Solana wallet for a user
   */
  async createWallet(userId: bigint, walletName: string = 'Main Wallet'): Promise<WalletCreationResult> {
    try {
      // Check if user already has a wallet with this name
      const existingWallet = await db.get<Wallet>(
        'SELECT * FROM wallets WHERE user_id = ? AND wallet_name = ?',
        [userId.toString(), walletName]
      );

      if (existingWallet) {
        return {
          wallet: existingWallet,
          success: false,
          error: 'Wallet with this name already exists'
        };
      }

      // Generate new keypair
      const keypair = Keypair.generate();
      const publicKey = keypair.publicKey.toString();
      const privateKeyBytes = keypair.secretKey; // Uint8Array
      const privateKeyHex = Buffer.from(privateKeyBytes).toString('hex');

      // Encrypt private key using master key + env salt/iv
      const encrypted: EncryptedWallet = WalletEncryption.encryptPrivateKey(privateKeyHex);

      // Check if this is the user's first wallet
      const walletCount = await db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM wallets WHERE user_id = ?',
        [userId.toString()]
      );

      const isPrimary = walletCount?.count === 0;

      // Insert wallet into database
      const walletId = crypto.randomUUID();
      await db.run(
        `INSERT INTO wallets (id, user_id, public_key, encrypted_private_key, iv, salt, tag, wallet_name, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          walletId,
          userId.toString(),
          publicKey,
          encrypted.encryptedPrivateKey,
          encrypted.iv,
          encrypted.salt,
          encrypted.tag,
          walletName,
          isPrimary
        ]
      );

      // Get the created wallet
      const wallet = await db.get<Wallet>(
        'SELECT * FROM wallets WHERE id = ?',
        [walletId]
      );

      if (!wallet) {
        throw new Error('Failed to retrieve created wallet');
      }

      // Update balance
      await this.updateWalletBalance(walletId);

      return { wallet, success: true };
    } catch (error) {
      console.error('Error creating wallet:', error);
      return {
        wallet: {} as Wallet,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Gets all wallets for a user
   */
  async getUserWallets(userId: bigint): Promise<Wallet[]> {
    const wallets = await db.all<Wallet>(
      'SELECT * FROM wallets WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC',
      [userId.toString()]
    );

    return wallets;
  }

  /**
   * Gets a specific wallet by ID
   */
  async getWallet(walletId: string): Promise<Wallet | null> {
    const wallet = await db.get<Wallet>(
      'SELECT * FROM wallets WHERE id = ?',
      [walletId]
    );

    return wallet || null;
  }

  /**
   * Gets user's primary wallet
   */
  async getPrimaryWallet(userId: bigint): Promise<Wallet | null> {
    const wallet = await db.get<Wallet>(
      'SELECT * FROM wallets WHERE user_id = ? AND is_primary = true',
      [userId.toString()]
    );

    return wallet || null;
  }

  /**
   * Sets a wallet as primary
   */
  async setPrimaryWallet(userId: bigint, walletId: string): Promise<boolean> {
    try {
      await db.transaction(async () => {
        // Remove primary status from all user wallets
        await db.run(
          'UPDATE wallets SET is_primary = false WHERE user_id = ?',
          [userId.toString()]
        );

        // Set the specified wallet as primary
        await db.run(
          'UPDATE wallets SET is_primary = true WHERE id = ? AND user_id = ?',
          [walletId, userId.toString()]
        );
      });

      return true;
    } catch (error) {
      console.error('Error setting primary wallet:', error);
      return false;
    }
  }

  /**
   * Gets the private key for a wallet (decrypted)
   */
  async getPrivateKey(walletId: string, userId: bigint): Promise<Uint8Array | null> {
    try {
      const wallet = await db.get<Wallet>(
        'SELECT * FROM wallets WHERE id = ? AND user_id = ?',
        [walletId, userId.toString()]
      );

      if (!wallet) {
        return null;
      }

      // Build encrypted payload
      const encrypted: EncryptedWallet = {
        encryptedPrivateKey: (wallet as any).encrypted_private_key,
        iv: (wallet as any).iv,
        salt: (wallet as any).salt,
        tag: (wallet as any).tag,
      };

      const privateKeyHex = WalletEncryption.decryptPrivateKey(encrypted);
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
      return new Uint8Array(privateKeyBytes);
    } catch (error) {
      console.error('Error decrypting private key:', error);
      return null;
    }
  }

  /**
   * Updates wallet balance from the blockchain
   */
  async updateWalletBalance(walletId: string): Promise<number> {
    try {
      const wallet = await this.getWallet(walletId);
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const publicKey = new PublicKey(wallet.public_key);
      const balance = await this.connection.getBalance(publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;

      // Update balance in database
      await db.run(
        'UPDATE wallets SET balance_sol = ?, last_balance_update = CURRENT_TIMESTAMP WHERE id = ?',
        [solBalance, walletId]
      );

      return solBalance;
    } catch (error) {
      console.error('Error updating wallet balance:', error);
      return 0;
    }
  }

  /**
   * Updates all wallet balances for a user
   */
  async updateAllUserWalletBalances(userId: bigint): Promise<void> {
    const wallets = await this.getUserWallets(userId);
    
    for (const wallet of wallets) {
      await this.updateWalletBalance(wallet.id);
    }
  }

  /**
   * Sends SOL from the user's primary wallet to a destination address
   */
  async sendSolFromPrimary(userId: bigint, toAddress: string, amountSOL: number): Promise<{ signature: string; walletId: string; }> {
    if (!toAddress) throw new Error('Destination address is required');
    if (!amountSOL || amountSOL <= 0) throw new Error('Amount must be > 0');

    const primary = await this.getPrimaryWallet(userId);
    if (!primary) throw new Error('No primary wallet found');

    return this.sendSolFromWallet(primary.id, userId, toAddress, amountSOL);
  }

  /**
   * Sends SPL tokens from the user's primary wallet to a destination address
   */
  async sendTokenFromPrimary(
    userId: bigint, 
    toAddress: string, 
    amount: number, 
    mintAddress: string
  ): Promise<{ signature: string; walletId: string; }> {
    if (!toAddress) throw new Error('Destination address is required');
    if (!amount || amount <= 0) throw new Error('Amount must be > 0');
    if (!mintAddress) throw new Error('Token mint address is required');

    const primary = await this.getPrimaryWallet(userId);
    if (!primary) throw new Error('No primary wallet found');

    return this.sendTokenFromWallet(primary.id, userId, toAddress, amount, mintAddress);
  }

  /**
   * Sends SPL tokens from a specific wallet
   */
  async sendTokenFromWallet(
    walletId: string,
    userId: bigint,
    toAddress: string,
    amount: number,
    mintAddress: string
  ): Promise<{ signature: string; walletId: string; }> {
    try {
      const fromWallet = await this.getWallet(walletId);
      if (!fromWallet) throw new Error('Wallet not found');

      const secret = await this.getPrivateKey(walletId, userId);
      if (!secret) throw new Error('Unable to decrypt private key');

      const payer = Keypair.fromSecretKey(secret);
      const toPublicKey = new PublicKey(toAddress);
      const mintPublicKey = new PublicKey(mintAddress);

      // Get token accounts
      const fromTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        payer.publicKey
      );

      const toTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        toPublicKey
      );

      // Check if destination token account exists
      const toAccountInfo = await this.connection.getAccountInfo(toTokenAccount);
      
      const { blockhash } = await this.connection.getLatestBlockhash('finalized');
      const tx = new SolanaTransaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });

      // Create associated token account if it doesn't exist
      if (!toAccountInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            toTokenAccount,
            toPublicKey,
            mintPublicKey
          )
        );
      }

      // Get token decimals to calculate the correct amount
      const mintInfo = await this.connection.getParsedAccountInfo(mintPublicKey);
      const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals || 6;
      const transferAmount = Math.floor(amount * Math.pow(10, decimals));

      // Add transfer instruction
      tx.add(
        createTransferInstruction(
          fromTokenAccount,
          toTokenAccount,
          payer.publicKey,
          transferAmount,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [payer],
        { commitment: 'confirmed' }
      );

      // Record transaction
      await this.recordTransaction(walletId, signature, 'send', amount, mintAddress, {
        to: toAddress,
        amount: transferAmount,
        decimals,
      });

      return { signature, walletId };
    } catch (error) {
      console.error('Error sending tokens:', error);
      throw error instanceof Error ? error : new Error('Unknown error while sending tokens');
    }
  }

  /**
   * Sends SOL from a specific wallet id
   */
  async sendSolFromWallet(walletId: string, userId: bigint, toAddress: string, amountSOL: number): Promise<{ signature: string; walletId: string; }> {
    try {
      const fromWallet = await this.getWallet(walletId);
      if (!fromWallet) throw new Error('Wallet not found');

      const secret = await this.getPrivateKey(walletId, userId);
      if (!secret) throw new Error('Unable to decrypt private key');

      const payer = Keypair.fromSecretKey(secret);
      const toPubkey = new PublicKey(toAddress);
      const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');
      const tx = new SolanaTransaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });
      tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey, lamports }));

      const signature = await sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: 'confirmed' });

      // record transaction
      await this.recordTransaction(walletId, signature, 'send', amountSOL, undefined, {
        to: toAddress,
        lamports,
        lastValidBlockHeight,
      });

      // update balance after send
      await this.updateWalletBalance(walletId);

      return { signature, walletId };
    } catch (error) {
      console.error('Error sending SOL:', error);
      throw error instanceof Error ? error : new Error('Unknown error while sending SOL');
    }
  }

  /**
   * Deletes a wallet (only if not primary and user has other wallets)
   */
  async deleteWallet(walletId: string, userId: bigint): Promise<boolean> {
    try {
      const wallet = await db.get<Wallet>(
        'SELECT * FROM wallets WHERE id = ? AND user_id = ?',
        [walletId, userId.toString()]
      );

      if (!wallet) {
        return false;
      }

      // Don't allow deletion of primary wallet if user has other wallets
      if (wallet.is_primary) {
        const walletCount = await db.get<{ count: number }>(
          'SELECT COUNT(*) as count FROM wallets WHERE user_id = ?',
          [userId.toString()]
        );

        if (walletCount && walletCount.count > 1) {
          throw new Error('Cannot delete primary wallet. Set another wallet as primary first.');
        }
      }

      await db.run('DELETE FROM wallets WHERE id = ?', [walletId]);
      return true;
    } catch (error) {
      console.error('Error deleting wallet:', error);
      return false;
    }
  }

  /**
   * Renames a wallet
   */
  async renameWallet(walletId: string, userId: bigint, newName: string): Promise<boolean> {
    try {
      // Check if name is already used by another wallet
      const existingWallet = await db.get<Wallet>(
        'SELECT * FROM wallets WHERE user_id = ? AND wallet_name = ? AND id != ?',
        [userId.toString(), newName, walletId]
      );

      if (existingWallet) {
        throw new Error('Wallet name already exists');
      }

      await db.run(
        'UPDATE wallets SET wallet_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [newName, walletId, userId.toString()]
      );

      return true;
    } catch (error) {
      console.error('Error renaming wallet:', error);
      return false;
    }
  }

  /**
   * Gets wallet transaction history
   */
  async getWalletTransactions(walletId: string, limit: number = 50): Promise<Transaction[]> {
    const transactions = await db.all<Transaction>(
      'SELECT * FROM transactions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT ?',
      [walletId, limit]
    );

    return transactions;
  }

  /**
   * Records a transaction
   */
  async recordTransaction(
    walletId: string,
    signature: string,
    type: Transaction['transaction_type'],
    amount: number,
    tokenMint?: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    const transactionId = crypto.randomUUID();
    
    await db.run(
      `INSERT INTO transactions (id, wallet_id, signature, transaction_type, amount, token_mint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        walletId,
        signature,
        type,
        amount,
        tokenMint || null,
        metadata ? JSON.stringify(metadata) : null
      ]
    );

    return transactionId;
  }

  /**
   * Updates transaction status
   */
  async updateTransactionStatus(
    transactionId: string,
    status: Transaction['status'],
    confirmedAt?: Date
  ): Promise<void> {
    await db.run(
      'UPDATE transactions SET status = ?, confirmed_at = ? WHERE id = ?',
      [status, confirmedAt?.toISOString() || null, transactionId]
    );
  }
}
