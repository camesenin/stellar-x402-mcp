import crypto from 'node:crypto';
import { X402Challenge } from './types.js';

export class ChallengeStore {
  private challenges = new Map<string, X402Challenge>();
  private redeemedChallenges = new Set<string>();
  private redeemedTxHashes = new Set<string>();

  constructor(private defaultTtlMs: number = 300_000) {}

  public createChallenge(
    destination: string,
    amount: string,
    asset: string,
    resource: string,
    network: 'testnet' | 'public' | 'custom' = 'testnet',
    contractId?: string,
    ttlMs?: number
  ): X402Challenge {
    const challengeId = crypto.randomBytes(16).toString('hex');
    const memo = challengeId.slice(0, 28); // Horizon text memo max length is 28 chars
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);

    const challenge: X402Challenge = {
      challengeId,
      destination,
      amount,
      asset,
      memo,
      network,
      contractId,
      resource,
      expiresAt,
    };

    this.challenges.set(challengeId, challenge);
    return challenge;
  }

  public getChallenge(challengeId: string): X402Challenge | undefined {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return undefined;

    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      return undefined;
    }

    return challenge;
  }

  public isTxRedeemed(txHash: string): boolean {
    return this.redeemedTxHashes.has(txHash.toLowerCase());
  }

  public isChallengeRedeemed(challengeId: string): boolean {
    return this.redeemedChallenges.has(challengeId);
  }

  public markRedeemed(challengeId: string, txHash: string): void {
    this.challenges.delete(challengeId);
    this.redeemedChallenges.add(challengeId);
    this.redeemedTxHashes.add(txHash.toLowerCase());
  }

  public cleanupExpired(): void {
    const now = Date.now();
    for (const [id, challenge] of this.challenges.entries()) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(id);
      }
    }
  }
}
