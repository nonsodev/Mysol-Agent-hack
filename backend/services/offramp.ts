import { 
  getRate,
  getTXPoolAddress,
  initializeSDK
} from 'paj_ramp';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Initialize PAJ SDK
const env = (process.env.PAJ_RAMP_ENV || 'staging') as 'staging' | 'production';
initializeSDK(env);

interface Bank {
  id: string;
  name: string;
  country: string;
  code?: string;
}

interface BankAccount {
  id: string;
  accountName: string;
  accountNumber: string;
  bank: string;
}

interface ResolvedBankAccount {
  accountName: string;
  accountNumber: string;
  bank: {
    id: string;
    name: string;
    code: string;
    country: string;
  };
}

interface OfframpOrderRequest {
  // Preferred: use an existing saved bank account
  bankAccountId?: string;
  // Legacy/alternate: direct bank + account number
  bank?: string;
  accountNumber?: string;
  currency: string;
  amount: number;
  mint: string;
}

interface OfframpOrderResponse {
  amount: number;
  expectedAmount: number;
  mint: string;
  decimals: number;
  address: string;
  walletId: string;
  creatorId: string;
  bankId: string;
  accountNumber: string;
  currency: string;
  status: string;
  _id: string;
  createdAt: string;
  updatedAt: string;
}

interface RateResponse {
  onRampRate?: {
    baseCurrency: string;
    targetCurrency: string;
    isActive: boolean;
    rate: number;
    type: string;
  };
  offRampRate?: {
    baseCurrency: string;
    targetCurrency: string;
    isActive: boolean;
    rate: number;
    type: string;
  };
}

export class OfframpService {
  private apiBaseUrl: string;

  constructor() {
    const env = process.env.PAJ_RAMP_ENV || 'staging';
    // Use API subdomain which returns JSON for public endpoints
    this.apiBaseUrl = env === 'production'
      ? 'https://api.paj.cash'
      : 'https://api.paj.cash'; // staging currently not on separate host; same public API
  }

  /**
   * Get list of available banks
   */
  async getBanks(): Promise<Bank[]> {
    try {
      const response = await axios.get(`${this.apiBaseUrl}/pub/offramp/bank`);
      const data = response.data;
      // Normalize various possible API shapes to an array
      if (Array.isArray(data)) return data as Bank[];
      if (data && Array.isArray(data.banks)) return data.banks as Bank[];
      if (data && data.data && Array.isArray(data.data)) return data.data as Bank[];
      // If single object returned, wrap in array
      if (data && typeof data === 'object') return [data as Bank];
      return [] as Bank[];
    } catch (error: any) {
      console.error('Error getting banks:', error?.response?.data || error);
      throw new Error('Failed to fetch banks');
    }
  }

  /**
   * Resolve and verify a bank account
   */
  async resolveBankAccount(bankId: string, accountNumber: string, pajToken?: string): Promise<ResolvedBankAccount> {
    try {
      // Primary (documented by provider): GET /pub/offramp/bank-account/comfirm
      // Note: provider endpoint may have a spelling variant (comfirm vs confirm).
      const urlPrimary = `${this.apiBaseUrl}/pub/offramp/bank-account/comfirm`;
      try {
        const res = await axios.get(urlPrimary, { 
          params: { bankId, accountNumber },
          headers: pajToken ? { 'Authorization': `Bearer ${pajToken}` } : undefined
        });
        return res.data as ResolvedBankAccount;
      } catch (e: any) {
        // Fallback: try "confirm" if primary path is not available
        const status = e?.response?.status;
        if (status && status !== 404) throw e;
        const urlFallback = `${this.apiBaseUrl}/pub/offramp/bank-account/confirm`;
        const res2 = await axios.get(urlFallback, { 
          params: { bankId, accountNumber },
          headers: pajToken ? { 'Authorization': `Bearer ${pajToken}` } : undefined
        });
        return res2.data as ResolvedBankAccount;
      }
    } catch (error: any) {
      console.error('Error resolving bank account:', error?.response?.data || error);
      throw new Error('Failed to resolve bank account. Please check the account number and try again.');
    }
  }

  /**
   * Add bank account to user's profile
   */
  async addBankAccount(token: string, bankId: string, accountNumber: string): Promise<BankAccount> {
    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/pub/offramp/bank-account`,
        { bankId, accountNumber },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error: any) {
      console.error('Error adding bank account:', error?.response?.data || error);
      throw new Error('Failed to add bank account');
    }
  }

  /**
   * Get user's saved bank accounts
   */
  async getUserBankAccounts(token: string): Promise<BankAccount[]> {
    try {
      const response = await axios.get(
        `${this.apiBaseUrl}/pub/offramp/bank-account`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error: any) {
      console.error('Error getting bank accounts:', error?.response?.data || error);
      throw new Error('Failed to fetch bank accounts');
    }
  }

  /**
   * Get current offramp rate
   */
  async getOfframpRate(amount?: number): Promise<any> {
    try {
      // If amount is provided, pass it; otherwise call with no arguments using type assertion
      const rate = amount !== undefined ? await getRate(amount) : await (getRate as any)();
      return rate;
    } catch (error: any) {
      // Graceful fallback: if rate-by-amount is unavailable, try base rate without amount
      const status = error?.response?.status;
      const msg = error?.response?.data || error?.message || error;
      console.error('Error getting offramp rate:', msg);
      if (amount !== undefined) {
        try {
          const base = await (getRate as any)();
          return base;
        } catch (e2: any) {
          console.error('Error getting base offramp rate:', e2?.response?.data || e2);
        }
      }
      throw new Error('Failed to fetch offramp rate');
    }
  }

  /**
   * Get TX pool address for receiving tokens
   */
  async getTXPoolAddress(): Promise<{ address: string }> {
    try {
      return await getTXPoolAddress();
    } catch (error) {
      console.error('Error getting TX pool address:', error);
      throw new Error('Failed to get TX pool address');
    }
  }

  /**
   * Create offramp order
   * This will return the address where user needs to send their tokens
   */
  async createOfframpOrder(
    token: string,
    orderData: OfframpOrderRequest
  ): Promise<OfframpOrderResponse[]> {
    try {
      // Make POST request to create offramp order
      const payload = orderData.bankAccountId
        ? { bankAccountId: orderData.bankAccountId, currency: orderData.currency, amount: orderData.amount, mint: orderData.mint }
        : { bank: orderData.bank, accountNumber: orderData.accountNumber, currency: orderData.currency, amount: orderData.amount, mint: orderData.mint };
      const response = await axios.post(
        `${this.apiBaseUrl}/pub/offramp/direct`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data;
    } catch (error: any) {
      console.error('Error creating offramp order:', error?.response?.data || error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to create offramp order';
      throw new Error(errorMessage);
    }
  }

  /**
   * Calculate expected fiat amount from token amount
   */
  async calculateExpectedFiat(tokenAmount: number, mint: string = 'USDC'): Promise<{
    tokenAmount: number;
    fiatAmount: number;
    rate: number;
    currency: string;
  }> {
    try {
      const rateData = await this.getOfframpRate(tokenAmount);
      
      // If amount was provided, use the detailed response
      if (rateData && rateData.amounts) {
        return {
          tokenAmount,
          fiatAmount: rateData.amounts.userAmountFiat,
          rate: rateData.rate.rate,
          currency: rateData.rate.targetCurrency
        };
      }
      
      // Otherwise use the basic rate
      if (rateData) {
        const offRampRate = rateData.offRampRate || rateData;
        if (offRampRate && typeof offRampRate.rate === 'number') {
          return {
            tokenAmount,
            fiatAmount: tokenAmount * offRampRate.rate,
            rate: offRampRate.rate,
            currency: offRampRate.targetCurrency || 'NGN'
          };
        }
      }
      // If still unavailable, return neutral values; caller should handle messaging
      return {
        tokenAmount,
        fiatAmount: 0,
        rate: 0,
        currency: 'NGN'
      };
    } catch (error) {
      console.error('Error calculating expected fiat:', error);
      // Return safe defaults instead of throwing to allow UX to proceed
      return {
        tokenAmount,
        fiatAmount: 0,
        rate: 0,
        currency: 'NGN'
      };
    }
  }

  /**
   * Format bank account for display
   */
  formatBankAccount(account: BankAccount): string {
    return `Account: ${account.accountNumber}\nName: ${account.accountName}\nBank: ${account.bank}`;
  }

  /**
   * Format bank for display
   */
  formatBank(bank: Bank): string {
    return `${bank.name} (${bank.country})`;
  }
}
