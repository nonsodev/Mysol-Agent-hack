import { db } from '../database/connection';
import { TelegramUser, UserPreferences, UserSession } from '../types';
import { hashPassword, verifyPassword } from '../utils/crypto';
import crypto from 'crypto';

export class UserService {
  /**
   * Creates or updates a user from Telegram data
   */
  async upsertUser(telegramUserData: {
    id: number;
    username?: string;
    first_name: string;
    last_name?: string;
    language_code?: string;
  }): Promise<TelegramUser> {
    const userId = BigInt(telegramUserData.id);
    
    // Check if user exists
    const existingUser = await db.get<TelegramUser>(
      'SELECT * FROM users WHERE telegram_id = ?',
      [userId.toString()]
    );

    if (existingUser) {
      // Update existing user
      await db.run(
        `UPDATE users SET 
         username = ?, first_name = ?, last_name = ?, 
         language_code = ?, updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ?`,
        [
          telegramUserData.username || null,
          telegramUserData.first_name,
          telegramUserData.last_name || null,
          telegramUserData.language_code || 'en',
          userId.toString()
        ]
      );
    } else {
      // Create new user
      await db.run(
        `INSERT INTO users (telegram_id, username, first_name, last_name, language_code)
         VALUES (?, ?, ?, ?, ?)`,
        [
          userId.toString(),
          telegramUserData.username || null,
          telegramUserData.first_name,
          telegramUserData.last_name || null,
          telegramUserData.language_code || 'en'
        ]
      );

      // Create default preferences
      await this.createDefaultPreferences(userId);
    }

    // Return updated user
    const user = await db.get<TelegramUser>(
      'SELECT * FROM users WHERE telegram_id = ?',
      [userId.toString()]
    );

    if (!user) {
      throw new Error('Failed to create/update user');
    }

    return user;
  }

  /**
   * Sets or updates a user's password (hashed). Never store plaintext.
   */
  async setUserPassword(userId: bigint, password: string): Promise<void> {
    const { hash, salt } = hashPassword(password);

    // Check if a secret already exists
    const exists = await db.get<{ user_id: string }>(
      'SELECT user_id FROM user_secrets WHERE user_id = ?',
      [userId.toString()]
    );

    if (exists) {
      await db.run(
        'UPDATE user_secrets SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [hash, salt, userId.toString()]
      );
    } else {
      await db.run(
        'INSERT INTO user_secrets (user_id, password_hash, password_salt) VALUES (?, ?, ?)',
        [userId.toString(), hash, salt]
      );
    }
  }

  /**
   * Verifies a provided password against the stored hash
   */
  async verifyUserPassword(userId: bigint, password: string): Promise<boolean> {
    const secret = await db.get<{ password_hash: string; password_salt: string }>(
      'SELECT password_hash, password_salt FROM user_secrets WHERE user_id = ?',
      [userId.toString()]
    );
    if (!secret) return false;
    return verifyPassword(password, secret.password_hash, secret.password_salt);
  }

  /**
   * Gets a user by Telegram ID
   */
  async getUser(telegramId: bigint): Promise<TelegramUser | null> {
    const user = await db.get<TelegramUser>(
      'SELECT * FROM users WHERE telegram_id = ?',
      [telegramId.toString()]
    );

    return user || null;
  }

  /**
   * Creates default preferences for a new user
   */
  private async createDefaultPreferences(userId: bigint): Promise<void> {
    await db.run(
      `INSERT INTO user_preferences (user_id) VALUES (?)`,
      [userId.toString()]
    );
  }

  /**
   * Gets user preferences
   */
  async getUserPreferences(userId: bigint): Promise<UserPreferences | null> {
    const prefs = await db.get<UserPreferences>(
      'SELECT * FROM user_preferences WHERE user_id = ?',
      [userId.toString()]
    );

    return prefs || null;
  }

  /**
   * Updates user preferences
   */
  async updateUserPreferences(
    userId: bigint, 
    updates: Partial<Omit<UserPreferences, 'user_id' | 'created_at' | 'updated_at'>>
  ): Promise<void> {
    const setClause = Object.keys(updates)
      .map(key => `${key} = ?`)
      .join(', ');
    
    const values = Object.values(updates);
    values.push(userId.toString());

    await db.run(
      `UPDATE user_preferences SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
      values
    );
  }

  /**
   * Creates or updates a user session
   */
  async upsertSession(userId: bigint, sessionData: Record<string, any>, expiresInMinutes: number = 60): Promise<string> {
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    
    // Check for existing session
    const existingSession = await db.get<UserSession>(
      'SELECT * FROM user_sessions WHERE user_id = ? AND expires_at > CURRENT_TIMESTAMP',
      [userId.toString()]
    );

    if (existingSession) {
      // Update existing session
      await db.run(
        'UPDATE user_sessions SET session_data = ?, expires_at = ? WHERE id = ?',
        [JSON.stringify(sessionData), expiresAt.toISOString(), existingSession.id]
      );
      return existingSession.id;
    } else {
      // Create new session
      const sessionId = crypto.randomUUID();
      await db.run(
        'INSERT INTO user_sessions (id, user_id, session_data, expires_at) VALUES (?, ?, ?, ?)',
        [sessionId, userId.toString(), JSON.stringify(sessionData), expiresAt.toISOString()]
      );
      return sessionId;
    }
  }

  /**
   * Gets a user session
   */
  async getSession(userId: bigint): Promise<UserSession | null> {
    const session = await db.get<UserSession>(
      'SELECT * FROM user_sessions WHERE user_id = ? AND expires_at > CURRENT_TIMESTAMP',
      [userId.toString()]
    );

    if (session && session.session_data) {
      try {
        session.session_data = JSON.parse(session.session_data as string);
      } catch (error) {
        console.error('Failed to parse session data:', error);
        session.session_data = {};
      }
    }

    return session || null;
  }

  /**
   * Clears expired sessions
   */
  async clearExpiredSessions(): Promise<void> {
    await db.run('DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
  }

  /**
   * Deactivates a user
   */
  async deactivateUser(userId: bigint): Promise<void> {
    await db.run(
      'UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [userId.toString()]
    );
  }

  /**
   * Gets user statistics
   */
  async getUserStats(userId: bigint): Promise<{
    walletCount: number;
    transactionCount: number;
    totalVolume: number;
    joinDate: Date;
  }> {
    const stats = await db.get<{
      wallet_count: number;
      transaction_count: number;
      total_volume: number;
      created_at: string;
    }>(
      `SELECT 
        (SELECT COUNT(*) FROM wallets WHERE user_id = ?) as wallet_count,
        (SELECT COUNT(*) FROM transactions t JOIN wallets w ON t.wallet_id = w.id WHERE w.user_id = ?) as transaction_count,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions t JOIN wallets w ON t.wallet_id = w.id WHERE w.user_id = ?) as total_volume,
        created_at
       FROM users WHERE telegram_id = ?`,
      [userId.toString(), userId.toString(), userId.toString(), userId.toString()]
    );

    if (!stats) {
      throw new Error('User not found');
    }

    return {
      walletCount: stats.wallet_count,
      transactionCount: stats.transaction_count,
      totalVolume: stats.total_volume,
      joinDate: new Date(stats.created_at)
    };
  }
}
