-- Database schema for Telegram bot with wallet management
-- This extends the existing LibSQL database used by Mastra

-- Users table - stores Telegram user information
CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY,
    username VARCHAR(255),
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255),
    language_code VARCHAR(10) DEFAULT 'en',
    timezone VARCHAR(50) DEFAULT 'UTC',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User secrets table - stores hashed password for convenience (never plain text)
CREATE TABLE IF NOT EXISTS user_secrets (
    user_id BIGINT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Wallets table - stores encrypted Solana wallets for users
CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id BIGINT NOT NULL,
    public_key VARCHAR(44) NOT NULL UNIQUE, -- Base58 encoded Solana public key
    encrypted_private_key TEXT NOT NULL, -- AES encrypted private key (hex)
    iv TEXT NOT NULL, -- hex IV for AES-GCM
    salt TEXT NOT NULL, -- hex PBKDF2 salt
    tag TEXT NOT NULL, -- hex auth tag
    wallet_name VARCHAR(255) DEFAULT 'Main Wallet',
    is_primary BOOLEAN DEFAULT false,
    balance_sol DECIMAL(20, 9) DEFAULT 0,
    last_balance_update TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- User sessions table - stores conversation context and temporary data
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id BIGINT NOT NULL,
    session_data TEXT, -- JSON string
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Transactions table - tracks all wallet transactions
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    wallet_id TEXT NOT NULL,
    signature VARCHAR(88) UNIQUE, -- Base58 encoded transaction signature
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('send', 'receive', 'swap', 'token_launch')),
    amount DECIMAL(20, 9) NOT NULL,
    token_mint VARCHAR(44), -- Token mint address (null for SOL)
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    metadata TEXT, -- JSON string for additional transaction data
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);

-- User preferences table - stores user settings and preferences
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id BIGINT PRIMARY KEY,
    notifications_enabled BOOLEAN DEFAULT true,
    auto_approve_small_amounts BOOLEAN DEFAULT false,
    max_auto_approve_amount DECIMAL(20, 9) DEFAULT 0.1,
    preferred_slippage DECIMAL(5, 2) DEFAULT 1.0, -- Percentage
    risk_tolerance VARCHAR(10) DEFAULT 'medium' CHECK (risk_tolerance IN ('low', 'medium', 'high')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_public_key ON wallets(public_key);
CREATE INDEX IF NOT EXISTS idx_wallets_is_primary ON wallets(user_id, is_primary);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_signature ON transactions(signature);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

-- Triggers to update timestamps
CREATE TRIGGER IF NOT EXISTS update_users_timestamp 
    AFTER UPDATE ON users
    BEGIN
        UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE telegram_id = NEW.telegram_id;
    END;

CREATE TRIGGER IF NOT EXISTS update_wallets_timestamp 
    AFTER UPDATE ON wallets
    BEGIN
        UPDATE wallets SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_preferences_timestamp 
    AFTER UPDATE ON user_preferences
    BEGIN
        UPDATE user_preferences SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
    END;

CREATE TRIGGER IF NOT EXISTS update_user_secrets_timestamp 
    AFTER UPDATE ON user_secrets
    BEGIN
        UPDATE user_secrets SET updated_at = CURRENT_TIMESTAMP WHERE user_id = NEW.user_id;
    END;

-- Ensure only one primary wallet per user
CREATE TRIGGER IF NOT EXISTS ensure_single_primary_wallet
    BEFORE INSERT ON wallets
    WHEN NEW.is_primary = true
    BEGIN
        UPDATE wallets SET is_primary = false WHERE user_id = NEW.user_id;
    END;

CREATE TRIGGER IF NOT EXISTS ensure_single_primary_wallet_update
    BEFORE UPDATE ON wallets
    WHEN NEW.is_primary = true AND OLD.is_primary = false
    BEGIN
        UPDATE wallets SET is_primary = false WHERE user_id = NEW.user_id AND id != NEW.id;
    END;
