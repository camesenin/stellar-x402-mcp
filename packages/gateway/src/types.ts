export type StellarNetwork = 'testnet' | 'public' | 'custom';

export interface X402Challenge {
  challengeId: string;
  destination: string;
  amount: string;
  asset: string;
  memo: string;
  network: StellarNetwork;
  contractId?: string;
  resource: string;
  expiresAt: number;
}

export interface PaymentProof {
  txHash: string;
  challengeId: string;
}

export interface GatewayConfig {
  destinationPublicKey: string;
  network?: StellarNetwork;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  defaultFeeXlm?: string;
  defaultFeeAsset?: string;
  challengeTtlMs?: number;
  contractId?: string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  payer?: string;
  amount?: string;
  asset?: string;
  ledger?: number;
  txHash?: string;
}

export interface PaidToolDefinition {
  name: string;
  description: string;
  pricing: {
    amount: string;
    asset: string;
  };
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, payment: VerificationResult) => Promise<unknown>;
}
