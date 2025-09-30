declare module 'paj_ramp' {
  export type Env = 'staging' | 'production';
  export function initializeSDK(env: Env): void;
  export function createOrder(input: {
    fiatAmount: number;
    currency: string;
    recipient: string;
    mint: string;
    chain: 'SOLANA' | 'ETHEREUM' | 'POLYGON';
    token: string;
  }): Promise<{ id: string; accountNumber: string; accountName: string; fiatAmount: number; bank: string }>;
  export function observeOrder(input: {
    orderId: string;
    onOrderUpdate?: (data: any) => void;
    onError?: (err: any) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    onConnectionStatusChange?: (connected: boolean) => void;
  }): { connect: () => Promise<void>; disconnect: () => void; isConnected: () => boolean };
}
