import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const paj: any = require("paj_ramp");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios: any = require("axios");

const EnvSchema = z.enum(["staging", "production"]).optional();

function ensureEnv(env?: string): "staging" | "production" {
  const v = (env ?? process.env.PAJ_RAMP_ENV ?? "staging").toString().toLowerCase();
  return v.startsWith("prod") ? "production" : "staging";
}

function getToken(inputToken?: string): string {
  const token = inputToken || process.env.PAJ_TOKEN || "";
  if (!token) throw new Error("Missing verification token. Set PAJ_TOKEN in env or pass token.");
  return token;
}

// getTXPoolAddressTool has been removed at user request. Use initiateOffRampTransfer for preparation guidance.

export const getOffRampRate = createTool({
  id: "getOffRampRate",
  description: "Get current off-ramp rate and optional quote for a specific USD amount.",
  inputSchema: z.object({
    usdAmount: z.number().positive().optional().describe("Optional amount in USD to quote taxes and fiat amount"),
    rateType: z.enum(["offRamp", "onRamp"]).default("offRamp").optional(),
    environment: EnvSchema,
  }),
  outputSchema: z.object({
    rate: z.any(),
    amounts: z.any().nullable(),
    summary: z.string(),
  }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);

    const RateType = paj.RateType || { offRamp: "offRamp", onRamp: "onRamp" };
    const desiredType = raw?.rateType === "onRamp" ? RateType.onRamp : RateType.offRamp;

    let out: any;
    if (typeof raw?.usdAmount === "number") {
      out = await paj.getRate(raw.usdAmount, desiredType);
    } else {
      out = await paj.getRate(desiredType);
    }

    // Shape may vary based on SDK version
    let rate = out?.offRampRate || out?.rate || out;
    const amounts = out?.amounts ?? null;
    // If SDK returns just a number for rate, wrap it so summary renders correctly
    if (typeof rate === 'number') {
      rate = { rate, baseCurrency: 'USD', targetCurrency: 'NGN', type: desiredType };
    }

    const summary = [
      `Off-ramp rate (${rate?.baseCurrency || "USD"} -> ${rate?.targetCurrency || "NGN"})`,
      `• Type: ${rate?.type || desiredType}`,
      `• Rate: ${rate?.rate ?? "unknown"}`,
      amounts ? `• Quote: userFiat=${amounts.userAmountFiat} userTax=${amounts.userTax} merchantTax=${amounts.merchantTax} amountUSD=${amounts.amountUSD}` : undefined,
    ].filter(Boolean).join("\n");

    return { rate, amounts, summary };
  },
});

export const getBanksTool = createTool({
  id: "getBanks",
  description: "List supported banks for off-ramp payouts.",
  inputSchema: z.object({ environment: EnvSchema }),
  outputSchema: z.object({ banks: z.array(z.any()), summary: z.string() }),
  execute: async (args: any) => {
    const env = ensureEnv(args?.input?.environment ?? args?.environment);
    paj.initializeSDK?.(env);
    const banks = await paj.getBanks();
    return { banks, summary: `Found ${Array.isArray(banks) ? banks.length : 0} banks` };
  },
});

export const resolveBankAccountTool = createTool({
  id: "resolveBankAccount",
  description: "Resolve a bank account number to verify account name and bank details.",
  inputSchema: z.object({
    bankId: z.string().min(1),
    accountNumber: z.string().min(6),
    environment: EnvSchema,
  }),
  outputSchema: z.object({
    accountName: z.string(),
    accountNumber: z.string(),
    bank: z.object({ id: z.string(), name: z.string(), code: z.string().optional(), country: z.string().optional() }),
  }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const res = await paj.resolveBankAccount(raw.bankId, raw.accountNumber);
    return res;
  },
});

export const addBankAccountTool = createTool({
  id: "addBankAccount",
  description: "Add a bank account for payouts using a verified session token.",
  inputSchema: z.object({
    bankId: z.string().min(1),
    accountNumber: z.string().min(6),
    token: z.string().optional(),
    environment: EnvSchema,
  }),
  outputSchema: z.object({ id: z.string(), accountName: z.string(), accountNumber: z.string(), bank: z.string() }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const token = getToken(raw?.token);
    const res = await paj.addBankAccount(token, raw.bankId, raw.accountNumber);
    return res;
  },
});

export const getBankAccountsTool = createTool({
  id: "getBankAccounts",
  description: "Get all bank accounts associated with your verified session token.",
  inputSchema: z.object({ token: z.string().optional(), environment: EnvSchema }),
  outputSchema: z.object({ accounts: z.array(z.any()), summary: z.string() }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const token = getToken(raw?.token);
    const accounts = await paj.getBankAccounts(token);
    return { accounts, summary: `Found ${Array.isArray(accounts) ? accounts.length : 0} bank accounts` };
  },
});

// Wallet tools and high-level withdraw planner

export const getWalletTool = createTool({
  id: "getWallet",
  description: "Get wallet info registered with PAJ using a public key.",
  inputSchema: z.object({
    publicKey: z.string().min(32).describe("Solana wallet public key"),
    environment: EnvSchema,
  }),
  outputSchema: z.object({
    id: z.string(),
    publicKey: z.string(),
    bankAccount: z.any().nullable(),
  }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const res = await paj.getWallet(raw.publicKey);
    return res;
  },
});

export const addWalletTool = createTool({
  id: "addWallet",
  description: "Register a wallet to your PAJ session and link it to a bank account.",
  inputSchema: z.object({
    bankAccountId: z.string().min(1),
    // secretKey as array of 64 numbers, consistent with SDK README example
    secretKey: z.array(z.number()).length(64),
    token: z.string().optional(),
    environment: EnvSchema,
  }),
  outputSchema: z.object({ id: z.string(), publicKey: z.string(), bankAccount: z.any() }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const token = getToken(raw?.token);
    const secretKey = Uint8Array.from(raw.secretKey);
    const res = await paj.addWallet(token, raw.bankAccountId, secretKey);
    return res;
  },
});

export const switchWalletBankAccountTool = createTool({
  id: "switchWalletBankAccount",
  description: "Switch the bank account linked to a registered wallet.",
  inputSchema: z.object({
    bankAccountId: z.string().min(1),
    walletId: z.string().min(1),
    // secret key used by SDK to authorize the switch
    secretKey: z.array(z.number()).length(64),
    token: z.string().optional(),
    environment: EnvSchema,
  }),
  outputSchema: z.object({ id: z.string(), publicKey: z.string(), bankAccount: z.any() }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const token = getToken(raw?.token);
    const secretKey = Uint8Array.from(raw.secretKey);
    const res = await paj.switchWalletBankAccount(token, raw.bankAccountId, raw.walletId, secretKey);
    return res;
  },
});

export const withdrawUSDToBank = createTool({
  id: "withdrawUSDToBank",
  description: "High-level helper: quote an off-ramp for a USD amount and route to your current/default bank account. If setup is incomplete, returns guided next steps.",
  inputSchema: z.object({
    usdAmount: z.number().positive(),
    environment: EnvSchema,
    token: z.string().optional(),
  }),
  outputSchema: z.object({
    summary: z.string(),
    nextSteps: z.array(z.string()),
    quote: z.any().nullable(),
    bankAccount: z.any().nullable(),
  }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const token = getToken(raw?.token);

    const RateType = paj.RateType || { offRamp: "offRamp", onRamp: "onRamp" };
    const quote = await paj.getRate(raw.usdAmount, RateType.offRamp);
    const rateObj = quote?.offRampRate || quote?.rate || quote;
    const amounts = quote?.amounts || null;

    let bankAccount: any = null;
    try {
      const accounts = await paj.getBankAccounts(token);
      bankAccount = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : null;
    } catch (e: any) {
      console.warn('withdrawUSDToBank: unable to fetch bank accounts, proceeding with guidance only. Error:', e?.message || e);
    }

    const nextSteps: string[] = [];
    if (!bankAccount) {
      nextSteps.push("No bank account found or endpoint unavailable. Add a bank account: call addBankAccountTool or use getBanksTool + resolveBankAccountTool first.");
    }
    nextSteps.push("Ensure your Solana wallet is registered with PAJ (use addWalletTool if not).");
    nextSteps.push("Send supported tokens (e.g., USDC) from your registered wallet to proceed with off-ramp settlement.");

    const lines: string[] = [];
    lines.push(`Off-ramp request prepared for ${raw.usdAmount} USD (${env}).`);
    if (rateObj) {
      const rateNum = typeof rateObj === 'number' ? rateObj : rateObj.rate;
      lines.push(`• Rate: ${rateNum}`);
    }
    if (amounts) {
      lines.push(`• Quote: amountUSD=${amounts.amountUSD}, userFiat=${amounts.userAmountFiat}, userTax=${amounts.userTax}, merchantTax=${amounts.merchantTax}`);
    }
    if (bankAccount) {
      lines.push(`• Using bank account: ${bankAccount.accountName} - ${bankAccount.accountNumber} (${bankAccount.bank})`);
    } else {
      lines.push("• No bank account found. Add one to complete withdrawal.");
    }

    return {
      summary: lines.join("\n"),
      nextSteps,
      quote: { rate: rateObj, amounts },
      bankAccount,
    };
  },
});

// Create offramp order using a saved bankAccountId (preferred)
export const createOfframpOrderByBankAccountId = createTool({
  id: "createOfframpOrderByBankAccountId",
  description: "Create a PAJ off-ramp order using an existing saved bank account ID. Returns order with destination address.",
  inputSchema: z.object({
    bankAccountId: z.string().min(1),
    amount: z.number().positive().describe("Token amount to send (e.g., USDC units)"),
    mint: z.string().min(32).describe("Token mint address (USDC on Solana by default)"),
    currency: z.string().default("NGN").optional(),
    token: z.string().optional(),
    environment: EnvSchema,
  }),
  outputSchema: z.object({
    orders: z.array(z.any()),
    summary: z.string(),
  }),
  execute: async (args: any) => {
    const raw = args?.input ?? args;
    const env = ensureEnv(raw?.environment);
    paj.initializeSDK?.(env);
    const token = getToken(raw?.token);

    // Use HTTP endpoint directly to ensure latest behavior
    const base = "https://api.paj.cash";
    const payload = {
      bankAccountId: raw.bankAccountId,
      amount: raw.amount,
      currency: raw.currency || "NGN",
      mint: raw.mint,
    };
    const res = await axios.post(`${base}/pub/offramp/direct`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const orders = res.data || [];
    const first = Array.isArray(orders) ? orders[0] : orders;
    const addr = first?.address ? `address ${first.address}` : "address unavailable";
    return {
      orders: Array.isArray(orders) ? orders : [orders],
      summary: `Created offramp order (${payload.amount} ${payload.mint}) → ${payload.currency}; send to ${addr}`,
    };
  },
});
