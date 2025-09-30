import TelegramBot, { SendMessageOptions } from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { UserService } from '../services/user';
import { WalletService } from '../services/wallet';
import { initializeSDK, createOrder } from 'paj_ramp';
import { UserSession } from '../types';
import { SwapService } from '../services/swap';
import { PortfolioService } from '../services/portfolio';
import { OfframpService } from '../services/offramp';
// Research mode tools
import { searchToken } from '../../src/mastra/agents/solana-agent/tools/searchToken';
import { tokenInfo } from '../../src/mastra/agents/solana-agent/tools/tokenInfo';
import { bundleChecker } from '../../src/mastra/agents/solana-agent/tools/bundleChecker';
import { getNFTPortfolio } from '../../src/mastra/agents/solana-agent/tools/getNFTPortfolio';
import { getWalletPortfolio } from '../../src/mastra/agents/solana-agent/tools/getWalletPortfolio';
import { tokenValidator, singleTokenValidator } from '../../src/mastra/agents/solana-agent/tools/tokenValidator';
import { OnlineSentimentService } from '../services/sentiment';

export class TelegramBotRunner {
  private bot: TelegramBot;
  private userService = new UserService();
  private walletService: WalletService;
  private swapService: SwapService;
  private portfolioService: PortfolioService;
  private sentimentService: OnlineSentimentService;
  private offrampService: OfframpService;

  constructor() {
    dotenv.config();
    
    // Initialize services AFTER dotenv.config()
    this.walletService = new WalletService(process.env.SOLANA_RPC_URL);
    this.swapService = new SwapService(process.env.SOLANA_RPC_URL);
    this.portfolioService = new PortfolioService(process.env.SOLANA_RPC_URL);
    this.sentimentService = new OnlineSentimentService();
    this.offrampService = new OfframpService();
    
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');

    this.bot = new TelegramBot(token, { polling: true });
    this.registerHandlers();
  }

  private registerHandlers() {
    this.bot.onText(/^\/start$/, async (msg) => {
      const chatId = msg.chat.id;
      const from = msg.from;
      if (!from) return;

      // Upsert user
      await this.userService.upsertUser({
        id: from.id,
        username: from.username,
        first_name: from.first_name || '',
        last_name: from.last_name,
        language_code: (from as any).language_code,
      });

      const text = [
        'Welcome to MySol Agent Bot! 🧠⚡',
        '',
        'Choose a mode to get started:',
        '- /wallet — Manage wallets: create, balance, send, swap, onramp, offramp',
        '- /research — Token and market research using natural language',
      ].join('\n');

      await this.bot.sendMessage(chatId, text);
    });

    // Mode switcher via explicit commands
    this.bot.onText(/^\/(wallet)$/i, async (msg) => {
      const chatId = msg.chat.id;
      const from = msg.from; if (!from) return;
      const userId = BigInt(from.id);
      try {
        await this.userService.upsertSession(userId, { mode: 'wallet' });
        await this.bot.sendMessage(chatId, [
          '✅ Wallet mode enabled. Try:',
          '- create wallet',
          '- what is my balance',
          '- show all tokens',
          '- USDC balance',
          '- send 0.01 SOL to <address>',
          '- swap 0.05 SOL to USDC',
          '- swap 10 USDC to BONK',
          '- onramp 2000',
          '- offramp 10  (natural language)',
        ].join('\n'));
      } catch (e: any) {
        await this.bot.sendMessage(chatId, `Failed to set mode: ${e?.message || e}`);
      }
    });

    this.bot.onText(/^\/(research)$/i, async (msg) => {
      const chatId = msg.chat.id;
      const from = msg.from; if (!from) return;
      const userId = BigInt(from.id);
      try {
        await this.userService.upsertSession(userId, { mode: 'research' });
        await this.bot.sendMessage(chatId, [
          '✅ Research mode enabled. Try:',
          '- search bonk',
          '- token info USDC',
          '- is this bundled DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
          '- nft portfolio 2Dk2je4iif7yttyGMLbjc8JrqUSMw2wqLPuHxVsJZ2Bg',
          '- sentiment BONK lang:en max:200',
        ].join('\n'));
      } catch (e: any) {
        await this.bot.sendMessage(chatId, `Failed to set mode: ${e?.message || e}`);
      }
    });

    // On-ramp command
    // Supports two forms:
    // 1) Minimal: /onramp <fiatAmount> [currency] [mint] [chain] [env]  → recipient defaults to primary wallet
    // 2) Full:    /onramp <fiatAmount> <currency> <recipient> <mint> [chain] [env]
    this.bot.onText(/^\/onramp(?:\s+(.+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      try {
        const raw = (match?.[1] || '').trim();
        if (!raw) {
          await this.bot.sendMessage(chatId, [
            'Usage:',
            'Minimal: /onramp <fiatAmount> [currency] [mint] [chain] [env]  (recipient = your primary wallet)',
            'Full:    /onramp <fiatAmount> <currency> <recipient> <mint> [chain] [env]',
          ].join('\n'));
          return;
        }

        const parts = raw.split(/\s+/);
        if (parts.length >= 4) {
          // Full form
          const [fiatStr, currency, recipient, mint, chainIn, envIn] = parts;
          const fiatAmount = Number(fiatStr);
          if (!fiatAmount || fiatAmount <= 0 || !currency || !recipient || !mint) {
            await this.bot.sendMessage(chatId, 'Invalid arguments. Usage: /onramp <fiatAmount> <currency> <recipient> <mint> [chain] [env]');
            return;
          }
          const chain = (chainIn || 'SOLANA').toUpperCase();
          const environment = (envIn || process.env.PAJ_RAMP_ENV || 'staging') as 'staging'|'production';
          initializeSDK(environment);
          const token = process.env.PAJ_TOKEN;
          if (!token) {
            await this.bot.sendMessage(chatId, 'Missing PAJ_TOKEN in environment. Please set it in the server .env');
            return;
          }
          await this.bot.sendMessage(chatId, 'Creating on-ramp order...');
          const order = await createOrder({ fiatAmount, currency, recipient, mint, chain, token }) as any;
          const amountDisp = (order as any)?.fiatAmount ?? (order as any)?.amount ?? fiatAmount;
          const currencyDisp = (order as any)?.currency ?? currency;
          const text = [
            '✅ On-ramp order created',
            `Order ID: ${order.id}`,
            `Amount: ${amountDisp} ${currencyDisp}`,
            `Bank: ${order.bank}`,
            `Account Name: ${order.accountName}`,
            `Account Number: ${order.accountNumber}`,
          ].join('\n');
          await this.bot.sendMessage(chatId, text);
          return;
        }

        // Minimal form → send to primary wallet
        const [fiatStr, currencyMaybe, mintMaybe, chainIn, envIn] = parts as [string, string?, string?, string?, string?];
        const fiatAmount = Number(fiatStr);
        if (!fiatAmount || fiatAmount <= 0) {
          await this.bot.sendMessage(chatId, 'Invalid amount. Example: /onramp 2000 NGN');
          return;
        }
        const from = msg.from; if (!from) return;
        const userId = BigInt(from.id);
        const primary = await this.walletService.getPrimaryWallet(userId);
        if (!primary) {
          await this.bot.sendMessage(chatId, 'No primary wallet found. Use "create wallet" first.');
          return;
        }
        const recipient = primary.public_key;
        const currency = (currencyMaybe || 'NGN').toUpperCase();
        const chain = (chainIn || 'SOLANA').toUpperCase();
        const environment = (envIn || process.env.PAJ_RAMP_ENV || 'staging') as 'staging'|'production';
        const DEFAULT_USDC_SOL = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqALUs2vVNCT9Ez4kWkmi3BYE3CZjHW47';
        const mint = mintMaybe || DEFAULT_USDC_SOL;
        initializeSDK(environment);
        const token = process.env.PAJ_TOKEN;
        if (!token) {
          await this.bot.sendMessage(chatId, 'Missing PAJ_TOKEN in environment. Please set it in the server .env');
          return;
        }
        await this.bot.sendMessage(chatId, `Creating on-ramp order to your primary wallet (recipient: ${recipient.slice(0,6)}...${recipient.slice(-6)})...`);
        const order = await createOrder({ fiatAmount, currency, recipient, mint, chain, token }) as any;
        const amountDisp = (order as any)?.fiatAmount ?? (order as any)?.amount ?? fiatAmount;
        const currencyDisp = (order as any)?.currency ?? currency;
        const out = [
          '✅ On-ramp order created',
          `Order ID: ${order.id}`,
          `Amount: ${amountDisp} ${currencyDisp}`,
          `Bank: ${order.bank}`,
          `Account Name: ${order.accountName}`,
          `Account Number: ${order.accountNumber}`,
        ].join('\n');
        await this.bot.sendMessage(chatId, out);
      } catch (err: any) {
        const apiErr = err?.response?.data || err?.response || err;
        const message = apiErr?.error || apiErr?.message || err?.message || String(err);
        await this.bot.sendMessage(chatId, `❌ Failed to create on-ramp order: ${message}`);
      }
    });

    // Offramp commands
    // List available banks with optional filter and pagination
    // Usage: /banks [filter]
    this.bot.onText(/^\/banks(?:\s+(.+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      try {
        const filterRaw = (match?.[1] || '').trim();
        await this.bot.sendMessage(chatId, `Fetching available banks${filterRaw ? ` (filter: ${filterRaw})` : ''}...`);
        const banks = await this.offrampService.getBanks();

        if (!banks || banks.length === 0) {
          await this.bot.sendMessage(chatId, 'No banks available at the moment.');
          return;
        }

        const filter = filterRaw.toLowerCase();
        const filtered = filter
          ? banks.filter(b =>
              (b.name || '').toLowerCase().includes(filter) ||
              (b.country || '').toLowerCase() === filter ||
              (b.id || '').toLowerCase().includes(filter)
            )
          : banks;

        if (!filtered.length) {
          await this.bot.sendMessage(chatId, `No banks found for "${filterRaw}".`);
          return;
        }

        // Create lines and paginate to stay under Telegram 4096 char limit
        const lines = filtered.map((bank, index) => `${index + 1}. ${bank.name} (${bank.country}) - ID: ${bank.id}`);
        const header = 'Available Banks:';
        const footer = '\nUse /banks <query> to filter (e.g., /banks NG, /banks sterling).\nUse /addbank <bank_id> <account_number> to add your bank account.';

        let currentChunk: string[] = [];
        let currentLen = header.length;
        const MAX_LEN = 3500; // conservative under Telegram 4096

        for (const line of lines) {
          // +1 for newline
          if (currentLen + line.length + 1 > MAX_LEN) {
            await this.bot.sendMessage(chatId, [header, '', ...currentChunk].join('\n'));
            currentChunk = [];
            currentLen = header.length;
          }
          currentChunk.push(line);
          currentLen += line.length + 1;
        }
        if (currentChunk.length) {
          await this.bot.sendMessage(chatId, [header, '', ...currentChunk, footer].join('\n'));
        }
      } catch (e: any) {
        const msgOut = e?.response?.data?.message || e?.message || String(e);
        await this.bot.sendMessage(chatId, `Failed to fetch banks: ${msgOut}`);
      }
    });

    // Add bank account: /addbank <bank_id> <account_number>
    this.bot.onText(/^\/addbank\s+([a-zA-Z0-9]+)\s+(\d+)$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const from = msg.from; if (!from) return;
      const userId = BigInt(from.id);
      
      if (!match) {
        await this.bot.sendMessage(chatId, 'Usage: /addbank <bank_id> <account_number>\nExample: /addbank 68781788c3ddffabdd90a96d 0025635480');
        return;
      }

      const [, bankId, accountNumber] = match;

      try {
        const pajToken = process.env.PAJ_TOKEN;
        if (!pajToken) {
          await this.bot.sendMessage(chatId, 'PAJ token not configured. Please contact administrator.');
          return;
        }

        await this.bot.sendMessage(chatId, 'Verifying bank account...');
        
        // First resolve the bank account to verify it (authorized)
        const resolved = await this.offrampService.resolveBankAccount(bankId, accountNumber, pajToken);
        
        await this.bot.sendMessage(chatId, 
          `✅ Account verified!\n\nAccount Name: ${resolved.accountName}\nAccount Number: ${resolved.accountNumber}\nBank: ${resolved.bank.name}\n\nAdding to your profile...`
        );

        // Add the bank account
        const added = await this.offrampService.addBankAccount(pajToken, bankId, accountNumber);
        
        // Save bank account ID to user session for easy access
        const currentSession = await this.userService.getSession(userId);
        await this.userService.upsertSession(userId, { 
          ...((currentSession as any)?.session_data || {}), 
          lastBankAccountId: added.id 
        });

        await this.bot.sendMessage(chatId, `✅ Bank account added successfully!\n\nAccount ID: ${added.id}\nYou can now use /offramp to withdraw funds.`);
      } catch (e: any) {
        await this.bot.sendMessage(chatId, `Failed to add bank account: ${e?.message || e}`);
      }
    });

    // List user's bank accounts
    this.bot.onText(/^\/mybanks$/i, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const pajToken = process.env.PAJ_TOKEN;
        if (!pajToken) {
          await this.bot.sendMessage(chatId, 'PAJ token not configured.');
          return;
        }

        const accounts = await this.offrampService.getUserBankAccounts(pajToken);
        
        if (!accounts || accounts.length === 0) {
          await this.bot.sendMessage(chatId, 'You have no bank accounts added yet.\nUse /banks to view available banks, then /addbank to add your account.');
          return;
        }

        const accountList = accounts.map((acc, index) => 
          `${index + 1}. ${acc.accountName}\n   Account: ${acc.accountNumber}\n   Bank: ${acc.bank}\n   ID: ${acc.id}`
        ).join('\n\n');
        
        await this.bot.sendMessage(chatId, `Your Bank Accounts:\n\n${accountList}`);
      } catch (e: any) {
        await this.bot.sendMessage(chatId, `Failed to fetch bank accounts: ${e?.message || e}`);
      }
    });

    // Offramp rate check
    this.bot.onText(/^\/offramprate(?:\s+(\d+(?:\.\d+)?))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      try {
        const amount = match?.[1] ? parseFloat(match[1]) : undefined;
        const rate = await this.offrampService.getOfframpRate(amount);
        
        if (amount && rate.amounts) {
          await this.bot.sendMessage(chatId, [
            `Offramp Rate for ${amount} USD:`,
            '',
            `Rate: ${rate.rate.rate} ${rate.rate.targetCurrency}/USD`,
            `You'll receive: ${rate.amounts.userAmountFiat} ${rate.rate.targetCurrency}`,
            `User Tax: ${rate.amounts.userTax}`,
            `Merchant Tax: ${rate.amounts.merchantTax}`,
          ].join('\n'));
        } else {
          const offRampRate = rate.offRampRate || rate;
          await this.bot.sendMessage(chatId, [
            'Current Offramp Rate:',
            '',
            `${offRampRate.baseCurrency} → ${offRampRate.targetCurrency}`,
            `Rate: ${offRampRate.rate}`,
            `Status: ${offRampRate.isActive ? 'Active' : 'Inactive'}`,
            '',
            'Use /offramprate <amount> to see exact conversion',
          ].join('\n'));
        }
      } catch (e: any) {
        await this.bot.sendMessage(chatId, `Failed to fetch rate: ${e?.message || e}`);
      }
    });

    // Main offramp command: /offramp <amount> <bank_account_id> [mint] [currency]
    // Example: /offramp 1 68781788c3ddffabdd90a96d EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v NGN
    this.bot.onText(/^\/offramp\s+(\d+(?:\.\d+)?)\s+([a-zA-Z0-9]+)(?:\s+([1-9A-HJ-NP-Za-km-z]{32,44}))?(?:\s+([A-Z]{3}))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const from = msg.from; if (!from) return;
      const userId = BigInt(from.id);

      if (!match) {
        await this.bot.sendMessage(chatId, [
          'Usage: /offramp <amount> <bank_account_id> [mint] [currency]',
          '',
          'Examples:',
          '/offramp 1 68781788c3ddffabdd90a96d',
          '/offramp 10 68781788c3ddffabdd90a96d EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v NGN',
          '',
          'Defaults:',
          '- Mint: USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)',
          '- Currency: NGN',
          '',
          'Use /mybanks to see your bank account IDs',
        ].join('\n'));
        return;
      }

      const [, amountStr, bankAccountId, mintAddress, currency] = match;
      const amount = parseFloat(amountStr);

      // Defaults
      const DEFAULT_USDC_MINT = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const mint = mintAddress || DEFAULT_USDC_MINT;
      const curr = currency || 'NGN';

      try {
        const pajToken = process.env.PAJ_TOKEN;
        if (!pajToken) {
          await this.bot.sendMessage(chatId, 'PAJ token not configured.');
          return;
        }

        // Get user's primary wallet
        const primary = await this.walletService.getPrimaryWallet(userId);
        if (!primary) {
          await this.bot.sendMessage(chatId, 'No primary wallet found. Create a wallet first with "create wallet"');
          return;
        }

        // Get bank account details to show confirmation
        const bankAccounts = await this.offrampService.getUserBankAccounts(pajToken);
        const bankAccount = bankAccounts.find(acc => acc.id === bankAccountId);

        if (!bankAccount) {
          await this.bot.sendMessage(chatId, `Bank account not found. Use /mybanks to see your saved accounts.`);
          return;
        }

        // Calculate expected fiat
        await this.bot.sendMessage(chatId, 'Calculating offramp details...');
        const calculation = await this.offrampService.calculateExpectedFiat(amount, mint);

        // Show confirmation details
        const confirmationMessage = [
          '⚠️ Offramp Confirmation Required',
          '',
          `Amount: ${amount} ${mint === DEFAULT_USDC_MINT ? 'USDC' : 'tokens'}`,
          `Expected Fiat: ${calculation.fiatAmount.toFixed(2)} ${calculation.currency}`,
          `Rate: ${calculation.rate} ${calculation.currency}/USD`,
          '',
          `Bank Account: ${bankAccount.accountName}`,
          `Account Number: ${bankAccount.accountNumber}`,
          `Bank: ${bankAccount.bank}`,
          '',
          'Type "confirm offramp" to proceed or "cancel" to abort.',
        ].join('\n');

        // Save pending offramp to session
        const currentSession = await this.userService.getSession(userId);
        await this.userService.upsertSession(userId, {
          ...((currentSession as any)?.session_data || {}),
          pending: {
            type: 'offramp',
            payload: {
              amount,
              bankAccountId,
              mint,
              currency: curr,
              calculation
            }
          }
        });

        await this.bot.sendMessage(chatId, confirmationMessage);
      } catch (e: any) {
        await this.bot.sendMessage(chatId, `Failed to prepare offramp: ${e?.message || e}`);
      }
    });

    // Natural language router based on mode
    this.bot.on('message', async (msg) => {
      if (!msg.text || msg.text.startsWith('/')) return; // ignore commands; handled elsewhere
      const chatId = msg.chat.id;
      const from = msg.from; if (!from) return;
      const userId = BigInt(from.id);

      // get current mode (default wallet)
      let mode = 'wallet';
      let sessionData: any = {};
      try {
        const sess = await this.userService.getSession(userId) as unknown as (UserSession & { session_data?: any }) | null;
        sessionData = (sess?.session_data as any) || {};
        if (sessionData.mode === 'research') mode = 'research';
      } catch {}

      const textBody = msg.text.trim();

      if (mode === 'wallet') {
        // Offramp natural language wizard
        // Start wizard when user mentions offramp/withdraw in natural language
        // Fast-path: "offramp <amount>" or "withdraw <amount>"
        const offrampWithAmount = textBody.match(/^\s*(offramp|withdraw)\s+(\d+(?:\.\d+)?)\s*$/i);
        if (/(^|\b)(offramp|withdraw)(\b|$)/i.test(textBody)) {
          try {
            if (offrampWithAmount) {
              const amt = Number(offrampWithAmount[2]);
              if (!amt || amt <= 0) {
                await this.bot.sendMessage(chatId, 'Please provide a valid numeric amount (e.g., 10).');
                return;
              }
              const pajToken = process.env.PAJ_TOKEN;
              if (pajToken) {
                try {
                  const accounts = await this.offrampService.getUserBankAccounts(pajToken);
                  if (accounts && accounts.length > 0) {
                    const opts = accounts.map(a => ({ id: a.id, accountName: a.accountName, accountNumber: a.accountNumber, bank: a.bank }));
                    const lines = opts.slice(0, 10).map((a, i) => `${i + 1}. ${a.accountName} — ${a.accountNumber} (${a.bank}) — ID: ${a.id}`);
                    await this.userService.upsertSession(userId, { ...sessionData, pending: { type: 'offramp_wizard', payload: { step: 'account_pick', amount: amt, options: opts.slice(0, 10) } } });
                    await this.bot.sendMessage(chatId, `Select a bank account by number (1-${Math.min(10, opts.length)}):\n\n${lines.join('\n')}`);
                    return;
                  }
                } catch {}
              }
              await this.userService.upsertSession(userId, { ...sessionData, pending: { type: 'offramp_wizard', payload: { step: 'bank_search', amount: amt } } });
              await this.bot.sendMessage(chatId, 'No saved bank accounts found. Which bank? Reply with a bank name or country code (e.g., "STERLING" or "NG").');
              return;
            }
            await this.userService.upsertSession(userId, { ...sessionData, pending: { type: 'offramp_wizard', payload: { step: 'amount' } } });
            await this.bot.sendMessage(chatId, 'How much do you want to offramp? (amount in USDC, e.g., 10)');
          } catch (e: any) {
            await this.bot.sendMessage(chatId, `Unable to start offramp wizard: ${e?.message || String(e)}`);
          }
          return;
        }

        // Continue wizard if in progress
        if (sessionData?.pending && sessionData.pending.type === 'offramp_wizard') {
          const wizard = sessionData.pending as { type: 'offramp_wizard'; payload: any };
          const step = wizard.payload?.step as string;
          try {
            if (step === 'amount') {
              const amt = Number(textBody.replace(/[^0-9.]/g, ''));
              if (!amt || amt <= 0) {
                await this.bot.sendMessage(chatId, 'Please provide a valid numeric amount (e.g., 10).');
                return;
              }
              // Prefer user's saved bank accounts
              const pajToken = process.env.PAJ_TOKEN;
              if (pajToken) {
                try {
                  const accounts = await this.offrampService.getUserBankAccounts(pajToken);
                  if (accounts && accounts.length > 0) {
                    const opts = accounts.map(a => ({ id: a.id, accountName: a.accountName, accountNumber: a.accountNumber, bank: a.bank }));
                    const lines = opts.slice(0, 10).map((a, i) => `${i + 1}. ${a.accountName} — ${a.accountNumber} (${a.bank}) — ID: ${a.id}`);
                    await this.userService.upsertSession(userId, {
                      ...sessionData,
                      pending: { type: 'offramp_wizard', payload: { step: 'account_pick', amount: amt, options: opts.slice(0, 10) } }
                    });
                    await this.bot.sendMessage(chatId, `Select a bank account by number (1-${Math.min(10, opts.length)}):\n\n${lines.join('\n')}`);
                    return;
                  }
                } catch {}
              }
              // Fallback to bank search flow if no saved accounts
              await this.userService.upsertSession(userId, {
                ...sessionData,
                pending: { type: 'offramp_wizard', payload: { step: 'bank_search', amount: amt } }
              });
              await this.bot.sendMessage(chatId, 'No saved bank accounts found. Which bank? Reply with a bank name or country code (e.g., "STERLING" or "NG").');
              return;
            }
            // Pick from existing saved bank accounts
            if (step === 'account_pick') {
              const idx = Number(textBody.trim());
              const options = wizard.payload?.options as Array<{ id: string; accountName: string; accountNumber: string; bank: string }>;
              if (!Number.isInteger(idx) || idx < 1 || idx > options.length) {
                await this.bot.sendMessage(chatId, `Please reply with a number between 1 and ${options.length}.`);
                return;
              }
              const chosen = options[idx - 1];
              const pajToken = process.env.PAJ_TOKEN;
              if (!pajToken) {
                await this.bot.sendMessage(chatId, 'PAJ token not configured on server. Contact the administrator.');
                return;
              }
              const DEFAULT_USDC_MINT = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
              const amount = Number(wizard.payload.amount);
              const calc = await this.offrampService.calculateExpectedFiat(amount, DEFAULT_USDC_MINT);
              const preview = [
                '⚠️ Offramp Confirmation Required',
                '',
                `Amount: ${amount} USDC`,
                `Expected Fiat: ${calc.fiatAmount.toFixed(2)} ${calc.currency}`,
                `Rate: ${calc.rate} ${calc.currency}/USD`,
                '',
                `Account Name: ${chosen.accountName}`,
                `Account Number: ${chosen.accountNumber}`,
                `Bank: ${chosen.bank}`,
                '',
                'Type "confirm offramp" to proceed or "cancel" to abort.'
              ].join('\n');

              await this.userService.upsertSession(userId, {
                ...sessionData,
                pending: {
                  type: 'offramp',
                  payload: {
                    amount,
                    bankAccountId: chosen.id,
                    mint: DEFAULT_USDC_MINT,
                    currency: calc.currency,
                    calculation: calc
                  }
                }
              });
              await this.bot.sendMessage(chatId, preview);
              return;
            }

            if (step === 'bank_search') {
              const query = textBody.trim().toLowerCase();
              const banks = await this.offrampService.getBanks();
              const matches = banks.filter(b =>
                (b.name || '').toLowerCase().includes(query) ||
                (b.country || '').toLowerCase() === query ||
                (b.id || '').toLowerCase().includes(query)
              );
              if (!matches.length) {
                await this.bot.sendMessage(chatId, 'No matching banks found. Try another name or use a country code like NG.');
                return;
              }
              const top = matches.slice(0, 10);
              const list = top.map((b, i) => `${i + 1}. ${b.name} (${b.country}) - ID: ${b.id}`).join('\n');
              await this.userService.upsertSession(userId, {
                ...sessionData,
                pending: { type: 'offramp_wizard', payload: { step: 'bank_pick', amount: wizard.payload.amount, options: top } }
              });
              await this.bot.sendMessage(chatId, `Select a bank by number (1-${top.length}):\n\n${list}`);
              return;
            }

            if (step === 'bank_pick') {
              const idx = Number(textBody.trim());
              const options = wizard.payload?.options as Array<{ id: string; name: string; country: string }>;
              if (!Number.isInteger(idx) || idx < 1 || idx > options.length) {
                await this.bot.sendMessage(chatId, `Please reply with a number between 1 and ${options.length}.`);
                return;
              }
              const chosen = options[idx - 1];
              await this.userService.upsertSession(userId, {
                ...sessionData,
                pending: { type: 'offramp_wizard', payload: { step: 'account', amount: wizard.payload.amount, bank: chosen } }
              });
              await this.bot.sendMessage(chatId, `Enter your bank account number for ${chosen.name}:`);
              return;
            }

            if (step === 'account') {
              const accountNumber = textBody.replace(/\D/g, '');
              if (!accountNumber || accountNumber.length < 6) {
                await this.bot.sendMessage(chatId, 'Please enter a valid bank account number.');
                return;
              }

              const pajToken = process.env.PAJ_TOKEN;
              if (!pajToken) {
                await this.bot.sendMessage(chatId, 'PAJ token not configured on server. Contact the administrator.');
                return;
              }

              // Verify account
              const bank = wizard.payload.bank as { id: string; name: string };
              const amount = Number(wizard.payload.amount);
              try {
                const resolved = await this.offrampService.resolveBankAccount(bank.id, accountNumber, pajToken);
                // Add bank account to get an ID
                const added = await this.offrampService.addBankAccount(pajToken, bank.id, accountNumber);

                // Calculate expected fiat
                const DEFAULT_USDC_MINT = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
                const calc = await this.offrampService.calculateExpectedFiat(amount, DEFAULT_USDC_MINT);

                const preview = [
                  '⚠️ Offramp Confirmation Required',
                  '',
                  `Amount: ${amount} USDC`,
                  `Expected Fiat: ${calc.fiatAmount.toFixed(2)} ${calc.currency}`,
                  `Rate: ${calc.rate} ${calc.currency}/USD`,
                  '',
                  `Account Name: ${resolved.accountName}`,
                  `Account Number: ${resolved.accountNumber}`,
                  `Bank: ${resolved.bank.name}`,
                  '',
                  'Type "confirm offramp" to proceed or "cancel" to abort.'
                ].join('\n');

                // Transition to standard confirmation flow
                await this.userService.upsertSession(userId, {
                  ...sessionData,
                  pending: {
                    type: 'offramp',
                    payload: {
                      amount,
                      bankAccountId: added.id,
                      mint: DEFAULT_USDC_MINT,
                      currency: calc.currency,
                      calculation: calc
                    }
                  }
                });

                await this.bot.sendMessage(chatId, preview);
              } catch (e: any) {
                await this.bot.sendMessage(chatId, `Failed to verify/add bank account: ${e?.message || String(e)}`);
              }
              return;
            }
          } catch (e: any) {
            await this.bot.sendMessage(chatId, `Wizard error: ${e?.message || String(e)}`);
          }
        }

        // Handle confirmations for pending actions first
        const confirmYes = /^(yes|y|confirm|confirm send|confirm swap|confirm offramp|proceed|proceed offramp)$/i;
        const confirmNo = /^(no|n|cancel|cancel send|cancel swap|cancel offramp|abort)$/i;
        if (sessionData?.pending && (confirmYes.test(textBody) || confirmNo.test(textBody))) {
          const pending = sessionData.pending as { type: 'send'|'swap'|'offramp'; payload: any };
          if (confirmNo.test(textBody)) {
            await this.userService.upsertSession(userId, { ...sessionData, pending: null });
            await this.bot.sendMessage(chatId, '❎ Cancelled.');
            return;
          }
          try {
            if (pending.type === 'send') {
              const { amount, toAddress } = pending.payload as { amount: number; toAddress: string };
              await this.bot.sendMessage(chatId, `Sending ${amount} SOL to ${toAddress.slice(0,6)}...${toAddress.slice(-6)} from your primary wallet...`);
              const { signature } = await this.walletService.sendSolFromPrimary(userId, toAddress, amount);
              const explorer = process.env.SOLANA_CLUSTER === 'devnet'
                ? `https://solscan.io/tx/${signature}?cluster=devnet`
                : `https://solscan.io/tx/${signature}`;
              await this.bot.sendMessage(chatId, `✅ Sent ${amount} SOL\nSignature: ${signature}\nExplorer: ${explorer}`);
            } else if (pending.type === 'swap') {
              const payload: any = pending.payload;
              if (payload && payload.token) {
                const { amount, token } = payload as { amount: number; token: string };
                await this.bot.sendMessage(chatId, `Swapping ${amount} SOL to ${token}...`);
                const { signature } = await this.swapService.swapSolToToken(userId, amount, token);
                const explorer = process.env.SOLANA_CLUSTER === 'devnet'
                  ? `https://solscan.io/tx/${signature}?cluster=devnet`
                  : `https://solscan.io/tx/${signature}`;
                await this.bot.sendMessage(chatId, `✅ Swap executed\nSignature: ${signature}\nExplorer: ${explorer}`);
              } else if (payload && payload.from && payload.to) {
                const { amount, from, to } = payload as { amount: number; from: string; to: string };
                await this.bot.sendMessage(chatId, `Swapping ${amount} ${from.toUpperCase()} to ${to.toUpperCase()}...`);
                const { signature } = await this.swapService.swapTokenToToken(userId, amount, from, to);
                const explorer = process.env.SOLANA_CLUSTER === 'devnet'
                  ? `https://solscan.io/tx/${signature}?cluster=devnet`
                  : `https://solscan.io/tx/${signature}`;
                await this.bot.sendMessage(chatId, `✅ Swap executed\nSignature: ${signature}\nExplorer: ${explorer}`);
              } else {
                await this.bot.sendMessage(chatId, 'Could not parse pending swap payload. Please re-issue the swap command.');
              }
            } else if (pending.type === 'offramp') {
              const { amount, bankAccountId, mint, currency } = pending.payload as { amount: number; bankAccountId: string; mint: string; currency: string };
              const pajToken = process.env.PAJ_TOKEN;
              if (!pajToken) {
                await this.bot.sendMessage(chatId, 'PAJ token not configured.');
                return;
              }

              await this.bot.sendMessage(chatId, 'Creating offramp order...');

              // Use saved bank account details to create the order (bank id + account number)
              const allAccounts = await this.offrampService.getUserBankAccounts(pajToken);
              const chosenAccount = allAccounts.find(a => a.id === bankAccountId);
              if (!chosenAccount) {
                await this.bot.sendMessage(chatId, 'Saved bank account not found.');
                return;
              }

              // Determine bankId: saved account may store bank name rather than ID
              let bankIdForOrder = chosenAccount.bank as unknown as string;
              const isMongoId = /^[a-f0-9]{24}$/i.test(bankIdForOrder || '');
              if (!isMongoId) {
                try {
                  const banks = await this.offrampService.getBanks();
                  const byExact = banks.find(b => (b.name || '').toLowerCase() === (bankIdForOrder || '').toLowerCase());
                  const byContains = byExact || banks.find(b => (b.name || '').toLowerCase().includes((bankIdForOrder || '').toLowerCase()));
                  if (byContains && byContains.id) bankIdForOrder = byContains.id;
                } catch {}
              }
              if (!/^[a-f0-9]{24}$/i.test(bankIdForOrder || '')) {
                await this.bot.sendMessage(chatId, 'Unable to resolve bank ID for the selected account. Please try again or re-add the bank account.');
                return;
              }

              const orderRequest = {
                bank: bankIdForOrder,
                accountNumber: chosenAccount.accountNumber,
                currency,
                amount,
                mint
              } as any;

              const orders = await this.offrampService.createOfframpOrder(pajToken, orderRequest);
              
              if (!orders || orders.length === 0) {
                await this.bot.sendMessage(chatId, '❌ Failed to create offramp order.');
                return;
              }

              const order = orders[0];

              await this.bot.sendMessage(chatId, [
                '✅ Offramp order created!',
                '',
                `Order ID: ${order._id}`,
                `Expected Amount: ${order.expectedAmount}`,
                `Status: ${order.status}`,
                `Send To Address: ${order.address}`,
                '',
                'Now sending tokens to offramp address...',
              ].join('\n'));

              // Send tokens from user's wallet to the order address
              try {
                const { signature } = await this.walletService.sendTokenFromPrimary(
                  userId,
                  order.address,
                  amount,
                  mint
                );

                const explorer = process.env.SOLANA_CLUSTER === 'devnet'
                  ? `https://solscan.io/tx/${signature}?cluster=devnet`
                  : `https://solscan.io/tx/${signature}`;

                await this.bot.sendMessage(chatId, [
                  '✅ Tokens sent successfully!',
                  '',
                  `Sent: ${amount} tokens to ${order.address}`,
                  `Signature: ${signature}`,
                  `Explorer: ${explorer}`,
                  '',
                  `Order ID: ${order._id}`,
                  `Status: ${order.status}`,
                  '',
                  'Fiat will be sent to your bank account once the transaction is confirmed.',
                ].join('\n'));
              } catch (sendError: any) {
                await this.bot.sendMessage(chatId, `❌ Failed to send tokens: ${sendError?.message || sendError}\n\nOrder created but tokens not sent. Order ID: ${order._id}`);
              }
            }
          } catch (e: any) {
            const msg = (e?.message || String(e)) as string;
            if (pending.type === 'offramp') {
              await this.bot.sendMessage(chatId, `❌ Offramp failed: ${msg}`);
            } else if (pending.type === 'send') {
              await this.bot.sendMessage(chatId, `❌ Send failed: ${msg}`);
            } else if (pending.type === 'swap') {
              // Shorten noisy errors
              if (/Simulation failed/i.test(msg) || /SendTransactionError/i.test(msg)) {
                await this.bot.sendMessage(chatId, '❌ Swap failed. Likely insufficient SOL for fees or route unavailable. Top up a small amount of SOL (e.g., 0.005) and try again.');
              } else if (/Insufficient/i.test(msg)) {
                await this.bot.sendMessage(chatId, `❌ Swap failed: ${msg}`);
              } else {
                await this.bot.sendMessage(chatId, '❌ Swap failed. Please try again shortly.');
              }
            } else {
              await this.bot.sendMessage(chatId, `❌ Action failed: ${msg}`);
            }
          } finally {
            await this.userService.upsertSession(userId, { ...sessionData, pending: null });
          }
          return;
        }
        // create wallet NL intents
        if (/\b(create\s+(a\s+)?)?wallet\b/i.test(textBody)) {
          try {
            const wallets = await this.walletService.getUserWallets(userId);
            const name = `Wallet ${wallets.length + 1}`;
            const result = await this.walletService.createWallet(userId, name);
            if (!result.success) {
              await this.bot.sendMessage(chatId, `Failed to create wallet: ${result.error}`);
            } else {
              await this.bot.sendMessage(chatId, `✅ Wallet created!\nName: ${name}\nPublic Key: ${result.wallet.public_key}`);
            }
          } catch (e: any) {
            await this.bot.sendMessage(chatId, `Error creating wallet: ${e?.message || e}`);
          }
          return;
        }

        // portfolio NL: "what is my balance", "show my portfolio", "holdings"
        if (/\b(what\s+is\s+my\s+balance|portfolio|holdings|my\s+balances|show\s+my\s+portfolio)\b/i.test(textBody)) {
          try {
            const p = await this.portfolioService.getPortfolioUSD(userId);
            const lines: string[] = [];
            lines.push(`Address: ${p.address}`);
            lines.push(`SOL: ${p.sol} (${p.solUSD ? `$${p.solUSD.toFixed(2)}` : 'no price'})`);
            if (p.tokens.length) {
              const top = p.tokens
                .slice(0, 10)
                .map(t => `- ${t.symbol}: ${t.amount}${t.usd ? ` ($${t.usd.toFixed(2)})` : ''}`);
              lines.push('Top tokens:');
              lines.push(...top);
            } else {
              lines.push('No SPL token balances found.');
            }
            lines.push(`Total (approx): ${p.totalUSD ? `$${p.totalUSD.toFixed(2)}` : 'n/a'}`);
            await this.bot.sendMessage(chatId, lines.join('\n'));
          } catch (e: any) {
            await this.bot.sendMessage(chatId, `Failed to fetch portfolio: ${e?.message || String(e)}`);
          }
          return;
        }

        // show all tokens NL
        if (/\b(show\s+all\s+tokens|list\s+all\s+tokens|all\s+tokens)\b/i.test(textBody)) {
          try {
            const p = await this.portfolioService.getPortfolioUSD(userId);
            if (!p.tokens.length) {
              await this.bot.sendMessage(chatId, 'No SPL token balances found.');
              return;
            }
            const lines: string[] = [];
            lines.push('All tokens:');
            for (const t of p.tokens) {
              lines.push(`- ${t.symbol}: ${t.amount}${t.usd ? ` ($${t.usd.toFixed(2)})` : ''}`);
            }
            await this.bot.sendMessage(chatId, lines.join('\n'));
          } catch (e: any) {
            await this.bot.sendMessage(chatId, `Failed to fetch tokens: ${e?.message || String(e)}`);
          }
          return;
        }

        // token-specific NL balances
        {
          const tokenBalanceRe = /\b(?:how\s+much\s+([A-Za-z0-9_:\-\.]{2,})\s+do\s+i\s+have|([A-Za-z0-9_:\-\.]{2,})\s+balance|balance\s+of\s+([A-Za-z0-9_:\-\.]{2,}))\b/i;
          const tm = textBody.match(tokenBalanceRe);
          if (tm) {
            const token = (tm[1] || tm[2] || tm[3] || '').trim();
            if (token) {
              try {
                const res = await this.portfolioService.filterTokenBalance(userId, token);
                if (!res) {
                  await this.bot.sendMessage(chatId, `No balance found for ${token}.`);
                } else {
                  const usdPart = res.usd ? ` (~$${res.usd.toFixed(2)})` : '';
                  await this.bot.sendMessage(chatId, `${res.symbol} balance: ${res.amount}${usdPart}`);
                }
              } catch (e: any) {
                await this.bot.sendMessage(chatId, `Failed to fetch ${token} balance: ${e?.message || String(e)}`);
              }
              return;
            }
          }
        }

        // send SOL: "send <amount> sol to <address>" (requires confirmation)
        {
          const sendRe = /\bsend\s+(\d+(?:\.\d+)?)\s+sol\s+to\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i;
          const sm = textBody.match(sendRe);
          if (sm) {
            const [, amtStr, toAddress] = sm;
            const amount = Number(amtStr);
            if (!amount || amount <= 0) {
              await this.bot.sendMessage(chatId, 'Invalid amount. Example: send 0.01 SOL to <address>');
              return;
            }
            // Save pending action and ask for confirmation
            await this.userService.upsertSession(userId, { ...sessionData, pending: { type: 'send', payload: { amount, toAddress } } });
            await this.bot.sendMessage(chatId, `You are about to send ${amount} SOL to ${toAddress}.\nType "confirm" to proceed or "cancel" to abort.`);
            return;
          }
        }

        // swap SOL -> token via Jupiter: "swap <amount> sol to <token>" (requires confirmation)
        {
          const swapRe = /\bswap\s+(\d+(?:\.\d+)?)\s+sol\s+to\s+([A-Za-z0-9_:\-\.]{2,})/i;
          const sm = textBody.match(swapRe);
          if (sm) {
            const [, amtStr, token] = sm;
            const amount = Number(amtStr);
            if (!amount || amount <= 0) {
              await this.bot.sendMessage(chatId, 'Invalid amount. Example: swap 0.05 SOL to USDC');
              return;
            }
            // Pre-confirmation fee check
            const FEE_BUFFER_SOL = Number(process.env.SWAP_FEE_BUFFER_SOL || '0.003');
            const primary = await this.walletService.getPrimaryWallet(userId);
            if (!primary) {
              await this.bot.sendMessage(chatId, 'No primary wallet found. Use "create wallet" first.');
              return;
            }
            const solBal = await this.walletService.updateWalletBalance(primary.id);
            const needSol = amount + FEE_BUFFER_SOL;
            if (solBal < needSol) {
              const topUp = (needSol - solBal);
              await this.bot.sendMessage(chatId, `You need ~${needSol.toFixed(6)} SOL (amount + fees). You have ${solBal.toFixed(6)} SOL. Top up ~${topUp.toFixed(6)} SOL, then try again.`);
              return;
            }
            await this.userService.upsertSession(userId, { ...sessionData, pending: { type: 'swap', payload: { amount, token } } });
            await this.bot.sendMessage(chatId, `You are about to swap ${amount} SOL to ${token}.\nType "confirm" to proceed or "cancel" to abort.`);
            return;
          }
        }

        // generic token-to-token swap: "swap <amount> <tokenA> to <tokenB>" (requires confirmation)
        {
          const swap2Re = /\bswap\s+(\d+(?:\.\d+)?)\s+([A-Za-z0-9_:\-\.]{2,})\s+to\s+([A-Za-z0-9_:\-\.]{2,})/i;
          const sm2 = textBody.match(swap2Re);
          if (sm2) {
            const [, amtStr, fromTk, toTk] = sm2;
            const amount = Number(amtStr);
            if (!amount || amount <= 0) {
              await this.bot.sendMessage(chatId, 'Invalid amount. Example: swap 10 USDC to BONK');
              return;
            }
            // Pre-confirmation fee check (require fee buffer if input is not SOL too)
            const FEE_BUFFER_SOL = Number(process.env.SWAP_FEE_BUFFER_SOL || '0.003');
            const primary = await this.walletService.getPrimaryWallet(userId);
            if (!primary) {
              await this.bot.sendMessage(chatId, 'No primary wallet found. Use "create wallet" first.');
              return;
            }
            const solBal = await this.walletService.updateWalletBalance(primary.id);
            const fromIsSol = fromTk.toLowerCase() === 'sol';
            const needSol = fromIsSol ? (amount + FEE_BUFFER_SOL) : FEE_BUFFER_SOL;
            if (solBal < needSol) {
              const topUp = (needSol - solBal);
              await this.bot.sendMessage(chatId, `You need ~${needSol.toFixed(6)} SOL for fees${fromIsSol ? ' (and amount)' : ''}. You have ${solBal.toFixed(6)} SOL. Top up ~${topUp.toFixed(6)} SOL, then try again.`);
              return;
            }
            await this.userService.upsertSession(userId, { ...sessionData, pending: { type: 'swap', payload: { amount, from: fromTk, to: toTk } } });
            await this.bot.sendMessage(chatId, `You are about to swap ${amount} ${fromTk.toUpperCase()} to ${toTk.toUpperCase()}.\nType "confirm" to proceed or "cancel" to abort.`);
            return;
          }
        }

        // onramp NL (primary wallet recipient):
        //   "onramp <fiat> [currency] [mint] [chain] [env]"
        {
          const simpleRe = /\bonramp\s+(\d+(?:\.\d+)?)(?:\s+([A-Za-z]{2,}))?(?:\s+([1-9A-HJ-NP-Za-km-z]{32,44}))?(?:\s+([A-Za-z]+))?(?:\s+(staging|production))?/i;
          const sm = textBody.match(simpleRe);
          if (sm) {
            const [, amtStr, currencyMaybe, mintMaybe, chainIn, envIn] = sm;
            const fiatAmount = Number(amtStr);
            const currency = (currencyMaybe || 'NGN').toUpperCase();
            const chain = (chainIn || 'SOLANA').toUpperCase();
            const environment = (envIn || process.env.PAJ_RAMP_ENV || 'production') as 'staging'|'production';
            try {
              const primary = await this.walletService.getPrimaryWallet(userId);
              if (!primary) {
                await this.bot.sendMessage(chatId, 'No primary wallet found. Use "create wallet" first or set one with /set_primary.');
                return;
              }
              const recipient = primary.public_key;
              const DEFAULT_USDC_SOL = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqALUs2vVNCT9Ez4kWkmi3BYE3CZjHW47';
              const mint = mintMaybe || DEFAULT_USDC_SOL;
              initializeSDK(environment);
              const token = process.env.PAJ_TOKEN;
              if (!token) {
                await this.bot.sendMessage(chatId, 'Missing PAJ_TOKEN in environment. Please set it in the server .env');
                return;
              }
              await this.bot.sendMessage(chatId, `Creating on-ramp order to your primary wallet (recipient: ${recipient.slice(0,6)}...${recipient.slice(-6)})...`);
              const order = await createOrder({ fiatAmount, currency, recipient, mint, chain, token }) as any;
              const amountDisp = (order as any)?.fiatAmount ?? (order as any)?.amount ?? fiatAmount;
              const currencyDisp = (order as any)?.currency ?? currency;
              const out = [
                '✅ On-ramp order created',
                `Order ID: ${order.id}`,
                `Amount: ${amountDisp} ${currencyDisp}`,
                `Bank: ${order.bank}`,
                `Account Name: ${order.accountName}`,
                `Account Number: ${order.accountNumber}`,
              ].join('\n');
              await this.bot.sendMessage(chatId, out);
              return;
            } catch (e: any) {
              const apiErr = e?.response?.data || e;
              const message = apiErr?.error || apiErr?.message || String(e);
              await this.bot.sendMessage(chatId, `❌ On-ramp failed: ${message}`);
              return;
            }
          }
        }

        // onramp NL (explicit recipient): "onramp <fiat> <currency> <recipient> <mint> [chain] [env]"
        const onrampRe = /\bonramp\s+(\d+(?:\.\d+)?)\s+([A-Za-z]{2,})\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+([A-Za-z]+))?(?:\s+(staging|production))?/i;
        const m = textBody.match(onrampRe);
        if (m) {
          const [, amtStr, currency, recipient, mint, chainIn, envIn] = m;
          const fiatAmount = Number(amtStr);
          const chain = (chainIn || 'SOLANA').toUpperCase();
          const environment = (envIn || process.env.PAJ_RAMP_ENV || 'staging') as 'staging'|'production';
          try {
            initializeSDK(environment);
            const token = process.env.PAJ_TOKEN;
            if (!token) {
              await this.bot.sendMessage(chatId, 'Missing PAJ_TOKEN in environment. Please set it in the server .env');
              return;
            }
            await this.bot.sendMessage(chatId, 'Creating on-ramp order...');
            const order = await createOrder({ fiatAmount, currency, recipient, mint, chain, token }) as any;
            const amountDisp = (order as any)?.fiatAmount ?? (order as any)?.amount ?? fiatAmount;
            const currencyDisp = (order as any)?.currency ?? currency;
            const out = [
              '✅ On-ramp order created',
              `Order ID: ${order.id}`,
              `Amount: ${amountDisp} ${currencyDisp}`,
              `Bank: ${order.bank}`,
              `Account Name: ${order.accountName}`,
              `Account Number: ${order.accountNumber}`,
            ].join('\n');
            await this.bot.sendMessage(chatId, out);
            return;
          } catch (e: any) {
            const apiErr = e?.response?.data || e;
            const message = apiErr?.error || apiErr?.message || String(e);
            await this.bot.sendMessage(chatId, `❌ On-ramp failed: ${message}`);
            return;
          }
        }

        // TODO: add send sol / swap / crosschain swap / trade intents
        await this.bot.sendMessage(chatId, 'Wallet mode ready. Try:\n- create wallet\n- what is my balance\n- show all tokens\n- USDC balance\n- send 0.01 SOL to <address>\n- swap 0.05 SOL to USDC\n- swap 10 USDC to BONK\n- onramp 2000');
        return;
      }

      if (mode === 'research') {
        // Sentiment relative-time aliases: "sentiment for <query> last week", "recent <query> sentiments"
        {
          const rel1 = textBody.match(/^\s*sentiment\s+for\s+(.+?)\s+(last\s+\d+\s+days|last\s+week|last\s+month|last\s+24h|past\s+week|past\s+month|yesterday|today)\s*$/i);
          const rel2 = textBody.match(/^\s*recent\s+(.+?)\s+sentiments?\s*$/i);
          const rel = rel1 || rel2;
          if (rel) {
            const query = (rel1 ? rel1[1] : rel2![1]).trim();
            const phrase = rel1 ? rel1[2].toLowerCase() : 'recent';
            const now = new Date();
            const until = new Date(now.getTime());
            let since = new Date(now.getTime());
            function fmt(d: Date) { return d.toISOString().slice(0,10); }
            if (/last\s+\d+\s+days/i.test(phrase)) {
              const n = Number((phrase.match(/last\s+(\d+)\s+days/i) as RegExpMatchArray)[1]);
              since.setDate(since.getDate() - Math.max(1, Math.min(30, n)));
            } else if (/last\s+24h/i.test(phrase)) {
              since.setDate(since.getDate() - 1);
            } else if (/last\s+week|past\s+week|recent/.test(phrase)) {
              since.setDate(since.getDate() - 7);
            } else if (/last\s+month|past\s+month/i.test(phrase)) {
              since.setMonth(since.getMonth() - 1);
            } else if (/yesterday/.test(phrase)) {
              since.setDate(since.getDate() - 1);
            } else if (/today/.test(phrase)) {
              // keep since as today
            }
            try {
              const res = await this.sentimentService.analyze(query, { tweetLanguage: 'en', since: fmt(since), until: fmt(until), maxItems: 200 });
              const total = res.total;
              const posP = total ? ((res.positive / total) * 100).toFixed(1) : '0.0';
              const negP = total ? ((res.negative / total) * 100).toFixed(1) : '0.0';
              const neuP = total ? ((res.neutral / total) * 100).toFixed(1) : '0.0';
              const lines: string[] = [];
              lines.push(`Online Sentiment for "${query}"`);
              lines.push(`Sampled: ${total} tweets (lang:en); since ${fmt(since)} until ${fmt(until)}`);
              lines.push(`Positive: ${res.positive} (${posP}%)`);
              lines.push(`Negative: ${res.negative} (${negP}%)`);
              lines.push(`Neutral: ${res.neutral} (${neuP}%)`);
              if (res.topTweets.length) {
                lines.push('Top tweets:');
                for (const t of res.topTweets) {
                  const by = t.author ? ` by @${t.author}` : '';
                  const likes = typeof t.likeCount === 'number' ? ` • ❤ ${t.likeCount}` : '';
                  lines.push(`- ${t.text.slice(0, 180)}${t.text.length > 180 ? '…' : ''}${likes}${t.url ? ` \n  ${t.url}` : ''}${by}`);
                }
              }
              await this.bot.sendMessage(chatId, lines.join('\n'));
            } catch (e: any) {
              const msg = e?.response?.data?.error || e?.message || String(e);
              await this.bot.sendMessage(chatId, `Failed to fetch sentiment: ${msg}`);
            }
            return;
          }
        }
        // Sentiment reversed phrasing: "<query> sentiment since last 2 months", "<query> sentiment since 10 days"
        {
          const m = textBody.match(/^\s*(.+?)\s+sentiments?\s+since\s+(?:last\s+)?(\d+)\s+(days?|weeks?|months?)\s*$/i);
          if (m) {
            const query = m[1].trim();
            const n = Math.max(1, Math.min(365, Number(m[2])));
            const unit = m[3].toLowerCase();
            const now = new Date();
            const until = new Date(now.getTime());
            const since = new Date(now.getTime());
            function fmt(d: Date) { return d.toISOString().slice(0,10); }
            if (unit.startsWith('day')) since.setDate(since.getDate() - n);
            else if (unit.startsWith('week')) since.setDate(since.getDate() - n * 7);
            else if (unit.startsWith('month')) since.setMonth(since.getMonth() - n);
            try {
              const res = await this.sentimentService.analyze(query, { tweetLanguage: 'en', since: fmt(since), until: fmt(until), maxItems: 200 });
              const total = res.total;
              const posP = total ? ((res.positive / total) * 100).toFixed(1) : '0.0';
              const negP = total ? ((res.negative / total) * 100).toFixed(1) : '0.0';
              const neuP = total ? ((res.neutral / total) * 100).toFixed(1) : '0.0';
              const lines: string[] = [];
              lines.push(`Online Sentiment for "${query}"`);
              lines.push(`Sampled: ${total} tweets (lang:en); since ${fmt(since)} until ${fmt(until)}`);
              lines.push(`Positive: ${res.positive} (${posP}%)`);
              lines.push(`Negative: ${res.negative} (${negP}%)`);
              lines.push(`Neutral: ${res.neutral} (${neuP}%)`);
              if (res.topTweets.length) {
                lines.push('Top tweets:');
                for (const t of res.topTweets) {
                  const by = t.author ? ` by @${t.author}` : '';
                  const likes = typeof t.likeCount === 'number' ? ` • ❤ ${t.likeCount}` : '';
                  lines.push(`- ${t.text.slice(0, 180)}${t.text.length > 180 ? '…' : ''}${likes}${t.url ? ` \n  ${t.url}` : ''}${by}`);
                }
              }
              await this.bot.sendMessage(chatId, lines.join('\n'));
            } catch (e: any) {
              const msg = e?.response?.data?.error || e?.message || String(e);
              await this.bot.sendMessage(chatId, `Failed to fetch sentiment: ${msg}`);
            }
            return;
          }
        }
        // Online Sentiment: "sentiment <query> [lang:en] [since:YYYY-MM-DD] [until:YYYY-MM-DD] [max:200]"
        {
          const m = textBody.match(/^\s*(?:online\s+)?sentiment\s+(.+)/i);
          if (m) {
            const rest = m[1].trim();
            // extract flags
            const lang = (rest.match(/\blang:([a-z]{2})\b/i)?.[1] || '').toLowerCase() || undefined;
            const since = rest.match(/\bsince:(\d{4}-\d{2}-\d{2})\b/i)?.[1];
            const until = rest.match(/\buntil:(\d{4}-\d{2}-\d{2})\b/i)?.[1];
            const maxStr = rest.match(/\bmax:(\d{1,4})\b/i)?.[1];
            const max = maxStr ? Math.min(1000, Math.max(50, Number(maxStr))) : undefined; // enforce sensible bounds
            // query is rest without flags
            const query = rest
              .replace(/\blang:[a-z]{2}\b/ig, '')
              .replace(/\bsince:\d{4}-\d{2}-\d{2}\b/ig, '')
              .replace(/\buntil:\d{4}-\d{2}-\d{2}\b/ig, '')
              .replace(/\bmax:\d{1,4}\b/ig, '')
              .trim();
            if (!query) {
              await this.bot.sendMessage(chatId, 'Usage: sentiment <query> [lang:en] [since:YYYY-MM-DD] [until:YYYY-MM-DD] [max:200]');
              return;
            }
            try {
              const res = await this.sentimentService.analyze(query, { tweetLanguage: lang, since, until, maxItems: max });
              const total = res.total;
              const posP = total ? ((res.positive / total) * 100).toFixed(1) : '0.0';
              const negP = total ? ((res.negative / total) * 100).toFixed(1) : '0.0';
              const neuP = total ? ((res.neutral / total) * 100).toFixed(1) : '0.0';
              const lines: string[] = [];
              lines.push(`Online Sentiment for "${query}"`);
              lines.push(`Sampled: ${total} tweets${lang ? ` (lang:${lang})` : ''}${since || until ? `; ${since ? `since ${since}` : ''}${until ? ` until ${until}` : ''}` : ''}`);
              lines.push(`Positive: ${res.positive} (${posP}%)`);
              lines.push(`Negative: ${res.negative} (${negP}%)`);
              lines.push(`Neutral: ${res.neutral} (${neuP}%)`);
              if (res.topTweets.length) {
                lines.push('Top tweets:');
                for (const t of res.topTweets) {
                  const by = t.author ? ` by @${t.author}` : '';
                  const likes = typeof t.likeCount === 'number' ? ` • ❤ ${t.likeCount}` : '';
                  lines.push(`- ${t.text.slice(0, 180)}${t.text.length > 180 ? '…' : ''}${likes}${t.url ? ` \n  ${t.url}` : ''}${by}`);
                }
              }
              await this.bot.sendMessage(chatId, lines.join('\n'));
            } catch (e: any) {
              const msg = e?.response?.data?.error || e?.message || String(e);
              await this.bot.sendMessage(chatId, `Failed to fetch sentiment: ${msg}`);
            }
            return;
          }
        }
        // Token search: "search <query>", "find <query>", "look up <query>"
        {
          const m = textBody.match(/\b(search|find|look\s*up)\s+(.+)/i);
          if (m) {
            const query = m[2].trim();
            try {
              const res = await (searchToken as any).execute({ input: { query } });
              await this.bot.sendMessage(chatId, res.summary || 'No token found.');
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Failed to search token: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Token info: "token info <query>", "tokeninfo <query>", "tell me about <query>", "token profile <query>"
        {
          const m = textBody.match(/\b(token\s*info|tokeninfo|tell\s+me\s+about|token\s*profile|profile\s+of)\s+(.+)/i);
          if (m) {
            const query = m[2].trim();
            try {
              const res = await (tokenInfo as any).execute({ input: { query } });
              await this.bot.sendMessage(chatId, res.summary || 'No info found.');
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Failed to get token info: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Short alias: "info <query>"
        {
          const m = textBody.match(/^\s*info\s+(.+)/i);
          if (m) {
            const query = m[1].trim();
            try {
              const res = await (tokenInfo as any).execute({ input: { query } });
              await this.bot.sendMessage(chatId, res.summary || 'No info found.');
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Failed to get token info: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Bundle checker: "is this bundled <mint>", "bundle checker <mint>", "bundle analysis <mint>", "check bundles <mint>"
        {
          const m = textBody.match(/\b(bundle\s*checker|bundle\s*analysis|is\s+this\s+bundled|check\s+bundles)\b.*?([1-9A-HJ-NP-Za-km-z]{32,44})/i);
          if (m) {
            const mintAddress = m[2];
            try {
              const res = await (bundleChecker as any).execute({ input: { mintAddress } });
              // IMPORTANT: Output formattedSummary EXACTLY as plain text (no extra markdown)
              await this.bot.sendMessage(chatId, res.formattedSummary);
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Bundle check failed: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Short alias: "bundle <mint>"
        {
          const m = textBody.match(/^\s*bundle\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/i);
          if (m) {
            const mintAddress = m[1];
            try {
              const res = await (bundleChecker as any).execute({ input: { mintAddress } });
              await this.bot.sendMessage(chatId, res.formattedSummary);
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Bundle check failed: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // NFT portfolio: "nft portfolio <wallet>", "show nfts <wallet>", "what nfts ... <wallet>"
        {
          const m = textBody.match(/\b(nft\s*portfolio|show\s+.*nfts|what\s+nfts.*|nfts\s+for)\b.*?([1-9A-HJ-NP-Za-km-z]{32,44})/i);
          if (m) {
            const walletAddress = m[2];
            try {
              const res = await (getNFTPortfolio as any).execute({ input: { walletAddress } });
              // Only display the text field
              const out = res?.text || 'No NFTs found or unable to fetch.';
              await this.bot.sendMessage(chatId, out);
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Failed to fetch NFT portfolio: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Short alias: "nfts <wallet>"
        {
          const m = textBody.match(/^\s*nfts\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/i);
          if (m) {
            const walletAddress = m[1];
            try {
              const res = await (getNFTPortfolio as any).execute({ input: { walletAddress } });
              const out = res?.text || 'No NFTs found or unable to fetch.';
              await this.bot.sendMessage(chatId, out);
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Failed to fetch NFT portfolio: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Wallet portfolio (tokens/SOL): "wallet portfolio <wallet>", "portfolio <wallet>"
        {
          const m = textBody.match(/\b(wallet\s*portfolio|portfolio)\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
          if (m) {
            const walletAddress = m[2];
            try {
              const res = await (getWalletPortfolio as any).execute({ input: { walletAddress } });
              const out = res?.text || 'No portfolio data available.';
              await this.bot.sendMessage(chatId, out);
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Failed to fetch wallet portfolio: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Token validation batch: "validate tokens <addr1> <addr2> ... [min <usd>]"
        {
          const m = textBody.match(/^\s*validate\s+tokens\s+(.+)/i);
          if (m) {
            const rest = m[1].trim();
            // Extract optional min
            const minMatch = rest.match(/\bmin\s+(\d+(?:\.\d+)?)/i);
            const minLiquidityUSD = minMatch ? Number(minMatch[1]) : undefined;
            const addrsStr = rest.replace(/\bmin\s+\d+(?:\.\d+)?/i, '').trim();
            const addrs = addrsStr.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
            if (!addrs.length) {
              await this.bot.sendMessage(chatId, 'Provide one or more token addresses. Example: validate tokens <addr1> <addr2> min 500');
              return;
            }
            try {
              const res = await (tokenValidator as any).execute({ input: { tokenAddresses: addrs, ...(minLiquidityUSD ? { minLiquidityUSD } : {}) } });
              await this.bot.sendMessage(chatId, res.summary || 'Validation complete.');
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Validation failed: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Single token validation: "validate token <addr> [min <usd>]"
        {
          const m = textBody.match(/^\s*validate\s+token\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+min\s+(\d+(?:\.\d+)?))?/i);
          if (m) {
            const tokenAddress = m[1];
            const minLiquidityUSD = m[2] ? Number(m[2]) : undefined;
            try {
              const res = await (singleTokenValidator as any).execute({ input: { tokenAddress, ...(minLiquidityUSD ? { minLiquidityUSD } : {}) } });
              const parts = [res.recommendation];
              if (typeof res.liquidityUSD === 'number') parts.push(`Liquidity: $${res.liquidityUSD.toFixed(2)}`);
              await this.bot.sendMessage(chatId, parts.join('\n'));
            } catch (e: any) {
              await this.bot.sendMessage(chatId, `Validation failed: ${e?.message || String(e)}`);
            }
            return;
          }
        }

        // Fallback help
        await this.bot.sendMessage(chatId, [
          'Research mode ready. Try:',
          '- search bonk',
          '- info USDC',
          '- bundle <mint>',
          '- nfts <wallet>',
          '- wallet portfolio <wallet>',
          '- validate token <mint> min 500',
          '- validate tokens <mint1> <mint2> min 500',
          '- sentiment BONK lang:en max:200',
        ].join('\n'));
        return;
      }
    });

    // Create wallet flow (no password; encryption uses master key + env IV/Salt)
    this.bot.onText(/^\/create_wallet(?:\s+(.+))?$/, async (msg) => {
      const chatId = msg.chat.id;
      const from = msg.from;
      if (!from) return;

      const userId = BigInt(from.id);
      try {
        const result = await this.walletService.createWallet(userId, 'Main Wallet');
        if (!result.success) {
          await this.bot.sendMessage(chatId, `Failed to create wallet: ${result.error}`);
          return;
        }

        const wallet = result.wallet;
        await this.bot.sendMessage(chatId, `✅ Wallet created!\nPublic Key: ${wallet.public_key}\nPrimary: ${wallet.is_primary ? 'Yes' : 'No'}`);
      } catch (err) {
        await this.bot.sendMessage(chatId, `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    });

    // List wallets
    this.bot.onText(/^\/wallets$/, async (msg) => {
      const chatId = msg.chat.id;
      const from = msg.from;
      if (!from) return;

      const userId = BigInt(from.id);
      const wallets = await this.walletService.getUserWallets(userId);

      if (!wallets.length) {
        await this.bot.sendMessage(chatId, 'You have no wallets yet. Use /create_wallet to create one.');
        return;
      }

      const lines = wallets.map((w, idx) => {
        const primary = w.is_primary ? ' (primary)' : '';
        const bal = typeof w.balance_sol === 'number' ? ` — ${w.balance_sol} SOL` : '';
        return `${idx + 1}. ${w.wallet_name}${primary}\n   ${w.public_key}${bal}`;
      });

      await this.bot.sendMessage(chatId, `Your wallets:\n\n${lines.join('\n')}`);
    });

    // Primary wallet balance
    this.bot.onText(/^\/balance$/, async (msg) => {
      const chatId = msg.chat.id;
      const from = msg.from;
      if (!from) return;

      const userId = BigInt(from.id);
      const wallet = await this.walletService.getPrimaryWallet(userId);
      if (!wallet) {
        await this.bot.sendMessage(chatId, 'No primary wallet found. Create one with /create_wallet.');
        return;
      }

      const sol = await this.walletService.updateWalletBalance(wallet.id);
      await this.bot.sendMessage(chatId, `Primary wallet balance:\n${wallet.public_key}\n${sol} SOL`);
    });

    // Set primary wallet by index or public key
    this.bot.onText(/^\/set_primary\s+(.+)$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const from = msg.from;
      if (!from) return;

      const userId = BigInt(from.id);
      const arg = (match?.[1] || '').trim();
      if (!arg) {
        await this.bot.sendMessage(chatId, 'Usage: /set_primary <wallet_index|public_key>');
        return;
      }

      const wallets = await this.walletService.getUserWallets(userId);
      if (!wallets.length) {
        await this.bot.sendMessage(chatId, 'You have no wallets yet. Use /create_wallet first.');
        return;
      }

      let targetId: string | null = null;
      const asNumber = Number(arg);
      if (!Number.isNaN(asNumber) && Number.isInteger(asNumber)) {
        const idx = asNumber - 1;
        if (idx >= 0 && idx < wallets.length) {
          targetId = wallets[idx].id;
        }
      }

      if (!targetId) {
        // Try match by public key prefix/full
        const byPk = wallets.find(w => w.public_key === arg || w.public_key.startsWith(arg));
        if (byPk) targetId = byPk.id;
      }

      if (!targetId) {
        await this.bot.sendMessage(chatId, 'Wallet not found. Provide a valid index (from /wallets) or full public key.');
        return;
      }

      const ok = await this.walletService.setPrimaryWallet(userId, targetId);
      if (ok) {
        const newPrimary = wallets.find(w => w.id === targetId);
        await this.bot.sendMessage(chatId, `Primary wallet set to:\n${newPrimary?.public_key}`);
      } else {
        await this.bot.sendMessage(chatId, 'Failed to set primary wallet.');
      }
    });

    // Set password (stored hashed in user_secrets)
    this.bot.onText(/^\/set_password$/, async (msg) => {
      const chatId = msg.chat.id;
      const from = msg.from;
      if (!from) return;

      const userId = BigInt(from.id);
      const opts: SendMessageOptions = {
        reply_markup: { force_reply: true, selective: true },
      };

      const info = [
        'Set a password for your account (stored hashed).',
        'This is not used for encryption anymore, but can be used for confirmations or future UX flows.',
        'Avoid sharing sensitive passwords used elsewhere.'
      ].join('\n');
      await this.bot.sendMessage(chatId, info);
      const prompt = await this.bot.sendMessage(chatId, 'Enter a new password:', opts);

      const replyListener = async (answerMsg: TelegramBot.Message) => {
        try {
          if (!answerMsg.reply_to_message || answerMsg.reply_to_message.message_id !== prompt.message_id) return;
          this.bot.removeListener('message', replyListener);

          const password = (answerMsg.text || '').trim();
          if (password.length < 8) {
            await this.bot.sendMessage(chatId, 'Password too short. Please run /set_password again (min 8 chars).');
            return;
          }

          await this.userService.setUserPassword(userId, password);
          await this.bot.sendMessage(chatId, '✅ Password set successfully.');
        } catch (err) {
          await this.bot.sendMessage(chatId, `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      };

      this.bot.on('message', replyListener);
    });
  }
}
