export type StellarNetwork = 'testnet' | 'public' | 'custom';

export interface ClientConfig {
  secretKey: string;
  network?: StellarNetwork;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  contractId?: string;
  maxPaymentPerCallXlm?: number; // Maximum XLM willing to pay for a single request (default 1.0)
  totalBudgetLimitXlm?: number;  // Maximum cumulative XLM for this client session (default 10.0)
}

export interface ClientPaymentReceipt {
  txHash: string;
  challengeId: string;
  destination: string;
  amount: string;
  asset: string;
  ledger?: number;
  timestamp: number;
}

export interface ParsedChallenge {
  challengeId: string;
  destination: string;
  amount: string;
  asset: string;
  memo: string;
  network: StellarNetwork;
  contractId?: string;
  tokenAddress?: string;
  expiresAt?: number;
}
