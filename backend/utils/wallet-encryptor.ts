import crypto from 'crypto';

export interface EncryptedWallet {
  encryptedPrivateKey: string;
  iv: string;
  salt: string;
  tag: string;
}

export class WalletEncryption {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32; // 256 bits
  private static readonly ITERATIONS = 100000; // PBKDF2 iterations

  private static getMasterKey(): Buffer {
    const master = process.env.ENCRYPTION_MASTER_KEY;
    if (!master) throw new Error('ENCRYPTION_MASTER_KEY not set');
    return Buffer.from(master, 'utf8');
  }

  private static getSalt(): Buffer {
    const saltHex = process.env.ENCRYPTION_SALT_HEX;
    if (!saltHex) throw new Error('ENCRYPTION_SALT_HEX not set');
    return Buffer.from(saltHex, 'hex');
  }


  // Derive key from master key and provided salt using PBKDF2
  private static deriveKeyFromMaster(): Buffer {
    const master = this.getMasterKey();
    const salt = this.getSalt();
    return crypto.pbkdf2Sync(master, salt, this.ITERATIONS, this.KEY_LENGTH, 'sha256');
  }

  // Encrypt private key using master-derived key and a per-wallet random IV
  static encryptPrivateKey(privateKey: string): EncryptedWallet {
    try {
      const key = this.deriveKeyFromMaster();
      const iv = crypto.randomBytes(16); // 128-bit IV per wallet
      const salt = this.getSalt();
      const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

      let encrypted = cipher.update(privateKey, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const tag = cipher.getAuthTag();

      return {
        encryptedPrivateKey: encrypted,
        iv: iv.toString('hex'),
        salt: salt.toString('hex'),
        tag: tag.toString('hex'),
      };
    } catch (error) {
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Decrypt using master-derived key and the stored IV
  static decryptPrivateKey(encryptedWallet: EncryptedWallet): string {
    try {
      const key = this.deriveKeyFromMaster();
      const { encryptedPrivateKey, tag, iv } = encryptedWallet;
      const tagBuffer = Buffer.from(tag, 'hex');
      const ivBuffer = Buffer.from(iv, 'hex');

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, ivBuffer);
      decipher.setAuthTag(tagBuffer);

      let decrypted = decipher.update(encryptedPrivateKey, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Invalid key or corrupted data'}`);
    }
  }

  static validatePassword(password: string): { isValid: boolean; requirements: string[] } {
    const requirements: string[] = [];
    let isValid = true;

    if (password.length < 12) {
      requirements.push('At least 12 characters long');
      isValid = false;
    }
    if (!/[A-Z]/.test(password)) {
      requirements.push('At least one uppercase letter');
      isValid = false;
    }
    if (!/[a-z]/.test(password)) {
      requirements.push('At least one lowercase letter');
      isValid = false;
    }
    if (!/[0-9]/.test(password)) {
      requirements.push('At least one number');
      isValid = false;
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      requirements.push('At least one special character');
      isValid = false;
    }

    return { isValid, requirements };
  }

  static generateSecurePassword(length: number = 16): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
    let password = '';

    for (let i = 0; i < length; i++) {
      const randomIndex = crypto.randomInt(0, charset.length);
      password += charset[randomIndex];
    }

    return password;
  }
}
