import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { initializeSDK, createOrder, observeOrder } from "paj_ramp";

const EnvSchema = z.enum(["staging", "production"]).optional();

function normalizeChain(input?: string): "SOLANA" | "ETHEREUM" | "POLYGON" {
  const t = (input ?? 'SOLANA').toString().trim().toLowerCase();
  if (t.startsWith("sol")) return "SOLANA";
  if (t.startsWith("eth")) return "ETHEREUM";
  if (t.startsWith("poly")) return "POLYGON";
  // default to SOLANA
  return "SOLANA";
}

export const createOnRampOrder = createTool({
  id: "createOnRampOrder",
  description: "Create an onramp order via PAJ Ramp and return bank/account details for payment.",
  inputSchema: z.object({
    fiatAmount: z.number().positive(),
    currency: z.string().min(2),
    recipient: z.string().min(32).describe("Wallet address to receive tokens"),
    mint: z.string().min(32).describe("Token mint address"),
    chain: z.string().default("SOLANA"),
    token: z.string().min(1).describe("Verification token from session verification").optional(),
    environment: EnvSchema,
  }),
  outputSchema: z.object({
    id: z.string(),
    accountNumber: z.string(),
    accountName: z.string(),
    fiatAmount: z.number(),
    bank: z.string(),
    summary: z.string(),
  }),
  execute: async (args: any) => {
    // Support various shapes from Mastra tool wrapper
    // Priority order covers most cases seen in Mastra Playground/dev server
    const raw =
      args?.input?.input ??
      args?.input?.args ??
      args?.args?.input ??
      args?.context?.input ??
      args?.context?.args ??
      args?.input ??
      args?.args ??
      args;
    if (!raw || typeof raw !== 'object') {
      console.error('[createOnRampOrder] Unexpected args shape. Top-level keys:', Object.keys(args || {}));
    }
    const env = raw.environment ?? (process.env.PAJ_RAMP_ENV as "staging" | "production" | undefined) ?? "staging";
    initializeSDK(env);

    // Resolve token from input or environment
    const token = raw.token || process.env.PAJ_TOKEN;
    if (!token) {
      console.error('[createOnRampOrder] Missing token. Received args keys:', Object.keys(args || {}));
      throw new Error("Missing verification token. Provide input.token or set PAJ_TOKEN in environment.");
    }
    console.log('[createOnRampOrder] Using token source:', raw.token ? 'raw.token' : 'env.PAJ_TOKEN');

    // Build a list of potential sources where the Playground may have placed fields
    const sources: any[] = [
      raw,
      raw?.input,
      raw?.args,
      raw?.context,
      raw?.context?.input,
      raw?.context?.args,
      args,
    ];

    const getFromSources = (keys: string[]): any => {
      for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        for (const k of keys) {
          if (k in src && src[k] !== undefined && src[k] !== null && src[k] !== '') {
            return src[k];
          }
        }
      }
      return undefined;
    };

    // Extract fields with sensible defaults and validation
    const fiatAmountRaw = getFromSources(['fiatAmount', 'amount', 'fiat']);
    const fiatAmount = typeof fiatAmountRaw === 'string' ? parseFloat(fiatAmountRaw) : Number(fiatAmountRaw);
    const currency = (getFromSources(['currency', 'fiatCurrency']) ?? 'NGN') as string;
    // Accept alternate field names sometimes used by UIs
    const recipientRaw = getFromSources(['recipient', 'walletAddress', 'recipientAddress']);
    const mintRaw = getFromSources(['mint', 'tokenMint', 'mintAddress']);
    const recipient = typeof recipientRaw === 'string' ? recipientRaw.trim() : recipientRaw;
    const mint = typeof mintRaw === 'string' ? mintRaw.trim() : mintRaw;
    const chainStr = (getFromSources(['chain']) ?? 'SOLANA') as string | undefined;

    console.log('[createOnRampOrder] Args snapshot:', {
      hasRecipient: Boolean(recipient),
      hasMint: Boolean(mint),
      fiatAmount,
      currency,
      chainStr,
    });
    if (raw && typeof raw === 'object') {
      try {
        console.log('[createOnRampOrder] Raw keys:', Object.keys(raw));
      } catch {}
    }
    if (raw?.context && typeof raw.context === 'object') {
      try { console.log('[createOnRampOrder] raw.context keys:', Object.keys(raw.context)); } catch {}
      if (raw.context?.input && typeof raw.context.input === 'object') {
        try { console.log('[createOnRampOrder] raw.context.input keys:', Object.keys(raw.context.input)); } catch {}
      }
      if (raw.context?.args && typeof raw.context.args === 'object') {
        try { console.log('[createOnRampOrder] raw.context.args keys:', Object.keys(raw.context.args)); } catch {}
      }
    }

    if (!recipient) {
      throw new Error('Missing recipient wallet address. Provide "recipient".');
    }
    if (!mint) {
      throw new Error('Missing token mint address. Provide "mint".');
    }
    if (!fiatAmount || fiatAmount <= 0) {
      throw new Error('Invalid fiatAmount. It must be a positive number.');
    }

    const order = await createOrder({
      fiatAmount,
      currency,
      recipient,
      mint,
      chain: normalizeChain(chainStr),
      token,
    });

    const summary = [
      "Onramp order created.",
      `• Order ID: ${order.id}`,
      `• Amount: ${order.fiatAmount} ${currency}`,
      `• Bank: ${order.bank}`,
      `• Account Name: ${order.accountName}`,
      `• Account Number: ${order.accountNumber}`,
      "Pay the amount to the provided account. You can ask me to observe this order for real-time updates.",
    ].join("\n");

    return { ...order, summary };
  },
});

export const observeOnRampOrder = createTool({
  id: "observeOnRampOrder",
  description: "Observe an onramp order in real time using PAJ Ramp Socket.IO stream and return recent updates.",
  inputSchema: z.object({
    orderId: z.string().min(1),
    environment: EnvSchema,
    waitSeconds: z.number().int().min(5).max(120).default(30),
  }),
  outputSchema: z.object({
    orderId: z.string(),
    connected: z.boolean(),
    updates: z.array(z.object({
      id: z.string(),
      fiatAmount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      mint: z.string(),
      chain: z.string(),
      status: z.string(),
      receivedAt: z.string(),
    })),
    lastStatus: z.string().optional(),
    note: z.string().optional(),
  }),
  execute: async (args) => {
    const input = args.input ?? args;
    const env = input.environment ?? (process.env.PAJ_RAMP_ENV as "staging" | "production" | undefined) ?? "staging";
    initializeSDK(env);

    const updates: Array<{ id: string; fiatAmount: string; currency: string; recipient: string; mint: string; chain: string; status: string; receivedAt: string; }> = [];
    let connected = false;

    const observer = observeOrder({
      orderId: input.orderId,
      onOrderUpdate: (data: any) => {
        updates.push({
          id: data.id,
          fiatAmount: String((data as any).fiatAmount ?? (data as any).amount ?? ""),
          currency: (data as any).currency ?? "",
          recipient: (data as any).recipient ?? "",
          mint: (data as any).mint ?? "",
          chain: String((data as any).chain ?? ""),
          status: String((data as any).status ?? ""),
          receivedAt: new Date().toISOString(),
        });
      },
      onConnect: () => { connected = true; },
      onDisconnect: () => { connected = false; },
      onError: (_err: any) => { /* swallow; will be reflected in connected=false/upd */ },
    });

    await observer.connect();

    // Keep the socket for the specified duration then disconnect
    const waitMs = (input.waitSeconds ?? 30) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    observer.disconnect();

    const lastStatus = updates.length ? updates[updates.length - 1].status : undefined;

    return {
      orderId: input.orderId,
      connected,
      updates,
      lastStatus,
      note: updates.length ? undefined : "No updates received in the time window. Try observing longer.",
    };
  },
});
