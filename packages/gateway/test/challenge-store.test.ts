import { describe, it, expect } from 'vitest';
import { ChallengeStore } from '../src/challenge-store.js';

describe('ChallengeStore', () => {
  it('creates challenges with unique nonces and correct TTL', () => {
    const store = new ChallengeStore(60_000);
    const challenge1 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/test-resource'
    );
    const challenge2 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/test-resource'
    );

    expect(challenge1.challengeId).toBeDefined();
    expect(challenge2.challengeId).toBeDefined();
    expect(challenge1.challengeId).not.toEqual(challenge2.challengeId);
    expect(challenge1.memo.length).toBeLessThanOrEqual(28);
    expect(challenge1.amount).toBe('0.05');
  });

  it('retrieves active challenge and returns undefined for unknown challenge', () => {
    const store = new ChallengeStore();
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.01',
      'XLM',
      '/api'
    );

    const fetched = store.getChallenge(challenge.challengeId);
    expect(fetched).toEqual(challenge);

    const nonExistent = store.getChallenge('non-existent-id');
    expect(nonExistent).toBeUndefined();
  });

  it('marks challenge and transaction as redeemed (anti-replay)', () => {
    const store = new ChallengeStore();
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.01',
      'XLM',
      '/api'
    );

    const dummyTx = 'a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef';
    expect(store.isTxRedeemed(dummyTx)).toBe(false);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);

    store.markRedeemed(challenge.challengeId, dummyTx);

    expect(store.isTxRedeemed(dummyTx)).toBe(true);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(true);
    // Challenge should no longer be fetched as active
    expect(store.getChallenge(challenge.challengeId)).toBeUndefined();
  });

  it('expires challenges after TTL elapsed', async () => {
    const store = new ChallengeStore(10); // 10ms TTL
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.01',
      'XLM',
      '/api',
      'testnet',
      undefined,
      10 // 10ms TTL
    );

    await new Promise((r) => setTimeout(r, 25));
    const expired = store.getChallenge(challenge.challengeId);
    expect(expired).toBeUndefined();
  });
});
