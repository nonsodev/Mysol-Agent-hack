// Core type definitions for the backend

export interface TelegramUser {
  telegram_id: bigint;
  username?: string;
  first_name: string;
  last_name?: string;
  language_code?: string;
  timezone?: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Wallet {
  id: string;
  user_id: bigint;
  public_key: string;
  encrypted_private_key: string;
  wallet_name: string;
  is_primary: boolean;
  balance_sol: number;
  last_balance_update: Date;
  created_at: Date;
  updated_at: Date;
}

export interface UserSession {
  id: string;
  user_id: bigint;
  session_data: Record<string, any>;
  expires_at: Date;
  created_at: Date;
}

export interface Transaction {
  id: string;
  wallet_id: string;
  signature: string;
  transaction_type: 'send' | 'receive' | 'swap' | 'token_launch';
  amount: number;
  token_mint?: string;
  status: 'pending' | 'confirmed' | 'failed';
  created_at: Date;
  confirmed_at?: Date;
}

export interface UserPreferences {
  user_id: bigint;
  notifications_enabled: boolean;
  auto_approve_small_amounts: boolean;
  max_auto_approve_amount: number;
  preferred_slippage: number;
  risk_tolerance: 'low' | 'medium' | 'high';
}

export interface BotCommand {
  command: string;
  description: string;
  handler: string;
  requiresWallet?: boolean;
  adminOnly?: boolean;
}

export interface WorkflowResult {
  success: boolean;
  data?: any;
  error?: string;
  message?: string;
}

export interface WalletCreationResult {
  wallet: Wallet;
  mnemonic?: string; // Only returned during creation
  success: boolean;
  error?: string;
}
