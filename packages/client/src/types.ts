export type StellarNetwork = 'testnet' | 'public' | 'custom';

export interface ClientConfig {
  secretKey: string;
  network?: StellarNetwork;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  contractId?: string;
  pinnedVaultContractId?: string;     // Client-side Vault pinning: rejects challenges specifying unexpected contracts
  allowedDestinations?: string[];       // Merchant address whitelist: rejects unapproved payTo addresses
  allowedTokens?: string[];             // Asset/Token contract whitelist (e.g. ['XLM', 'USDC'])
  maxPaymentPerCallXlm?: number;       // Hard cap on single tool execution cost (default 1.0 XLM)
  totalBudgetLimitXlm?: number;        // Maximum cumulative XLM for this client session (default 10.0 XLM)
  validateSimulationAuth?: boolean;    // Verify Soroban auth footprint tree before signing (default true)
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
