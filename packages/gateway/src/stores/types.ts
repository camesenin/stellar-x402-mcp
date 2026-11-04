import { X402Challenge, VerificationResult } from '../types.js';

export type ChallengeStatus =
  | 'PENDING'
  | 'RECONCILIATION_REQUIRED'
  | 'INCONCLUSIVE_MANUAL_REVIEW'
  | 'CONFIRMED'
  | 'REDEEMED'
  | 'CANCELLED'
  | 'PERMANENT_QUARANTINE';

export interface StoredChallengeRecord extends X402Challenge {
  status: ChallengeStatus;
  boundTxHash?: string;
  createdLedger?: number;
  minValidLedger?: number;
  maxValidLedger?: number;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  leaseGeneration: number;
  version: number;
  redeemedAt?: Date;
  redeemedLedger?: number;
  payer?: string;
  paidAmountStroops?: string;
}

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
      beneficiary?: string;
      memo?: string;
      ttlSeconds?: number;
      createdLedger?: number;
    }
  ): Promise<X402Challenge>;

  getChallenge(challengeId: string): Promise<StoredChallengeRecord | null>;

  bindSubmissionTx(
    challengeId: string,
    txHash: string,
    bounds: {
      minValidLedger?: number;
      maxValidLedger?: number;
    }
  ): Promise<boolean>;

  markRedeemed(
    challengeId: string,
    txHash: string,
    details?: {
      payer?: string;
      amount?: string;
      asset?: string;
      ledger?: number;
      leaseGeneration?: number;
      leaseOwner?: string;
    }
  ): Promise<boolean>;

  isChallengeRedeemed(challengeId: string): Promise<boolean>;

  isTxRedeemed(txHash: string): Promise<boolean>;

  getPendingChallenges(limit?: number): Promise<StoredChallengeRecord[]>;

  updateChallengeStatus(
    challengeId: string,
    status: ChallengeStatus,
    options?: {
      expectedStatus?: ChallengeStatus;
      expectedVersion?: number;
      leaseGeneration?: number;
      leaseOwner?: string;
      reason?: string;
    }
  ): Promise<boolean>;

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
