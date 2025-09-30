import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits
const TAG_LENGTH = 16; // 128 bits

/**
 * Derives an encryption key from master key and user ID
 */
function deriveKey(masterKey: string, userId: bigint, salt: Buffer): Buffer {
  const userIdBuffer = Buffer.from(userId.toString());
  const keyMaterial = Buffer.concat([Buffer.from(masterKey), userIdBuffer]);
  
  return crypto.pbkdf2Sync(keyMaterial, salt, 100000, KEY_LENGTH, 'sha256');
}

/**
 * Encrypts data using AES-256-GCM
 */
export function encrypt(data: string | Buffer, userId: bigint): string {
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY not found in environment variables');
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(masterKey, userId, salt);
  
  const cipher = crypto.createCipher(ALGORITHM, key);
  cipher.setAAD(Buffer.from(userId.toString())); // Additional authenticated data
  
  const dataBuffer = typeof data === 'string' ? Buffer.from(data) : data;
  
  let encrypted = cipher.update(dataBuffer);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  const tag = cipher.getAuthTag();
  
  // Combine salt + iv + tag + encrypted data
  const result = Buffer.concat([salt, iv, tag, encrypted]);
  
  return result.toString('base64');
}

/**
 * Decrypts data using AES-256-GCM
 */
export function decrypt(encryptedData: string, userId: bigint): Buffer {
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY not found in environment variables');
  }

  const buffer = Buffer.from(encryptedData, 'base64');
  
  // Extract components
  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  
  const key = deriveKey(masterKey, userId, salt);
  
  const decipher = crypto.createDecipher(ALGORITHM, key);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(userId.toString()));
  
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return decrypted;
}

/**
 * Generates a secure random string for API keys, etc.
 */
export function generateSecureRandom(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hashes a password using PBKDF2
 */
export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const saltBuffer = salt ? Buffer.from(salt, 'hex') : crypto.randomBytes(32);
  const hash = crypto.pbkdf2Sync(password, saltBuffer, 100000, 64, 'sha256');
  
  return {
    hash: hash.toString('hex'),
    salt: saltBuffer.toString('hex')
  };
}

/**
 * Verifies a password against a hash
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const { hash: computedHash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computedHash, 'hex'));
}
