import { X402Challenge, VerificationResult } from '../types.js';

export interface IChallengeStore {
  createChallenge(
    destination: string,
    amount: string,
    asset: string,
    resource: string,
    options?: {
      network?: 'testnet' | 'public' | 'custom';
      contractId?: string;
      tokenAddress?: string;
      memo?: string;
      ttlSeconds?: number;
    }
  ): Promise<X402Challenge>;

  getChallenge(challengeId: string): Promise<X402Challenge | null>;

  markRedeemed(
    challengeId: string,
    txHash: string,
    details?: {
      payer?: string;
      amount?: string;
      asset?: string;
      ledger?: number;
    }
  ): Promise<boolean>;

  isChallengeRedeemed(challengeId: string): Promise<boolean>;

  isTxRedeemed(txHash: string): Promise<boolean>;

  acquireLease(
    challengeId: string,
    workerId: string,
    ttlSeconds: number
  ): Promise<{ acquired: boolean; leaseGeneration: number }>;

  renewLease(
    challengeId: string,
    workerId: string,
    expectedGeneration: number,
    ttlSeconds: number
  ): Promise<boolean>;

  releaseLease(
    challengeId: string,
    workerId: string,
    expectedGeneration: number
  ): Promise<boolean>;
}
