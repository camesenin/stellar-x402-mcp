import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChallengeStore } from '../src/challenge-store.js';

describe('ChallengeStore (SQLite Persistence & Anti-Replay)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `x402_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // Ignored on Windows file lock during rapid tests
      }
    }
  });

  it('creates and retrieves challenges from SQLite', () => {
    const store = new ChallengeStore(tempDbPath, 60_000);
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/test-resource'
    );

    expect(challenge.challengeId).toBeDefined();
    expect(challenge.memo.length).toBeLessThanOrEqual(28);

    const fetched = store.getChallenge(challenge.challengeId);
    expect(fetched).toBeDefined();
    expect(fetched?.challengeId).toBe(challenge.challengeId);
    expect(fetched?.amount).toBe('0.05');

    store.close();
  });

  it('preserves redeemed transactions across store restart (Anti-Replay)', () => {
    const dummyTx = '99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff';

    // Session 1: Server runs, issues challenge, redeems transaction
    const store1 = new ChallengeStore(tempDbPath);
    const challenge = store1.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.10',
      'XLM',
      '/premium'
    );

    expect(store1.isTxRedeemed(dummyTx)).toBe(false);
    store1.markRedeemed(challenge.challengeId, dummyTx, {
      payer: 'GCPAYER123',
      amount: '0.10',
      asset: 'XLM',
      ledger: 123456,
    });
    expect(store1.isTxRedeemed(dummyTx)).toBe(true);

    // Simulate Server Crash / Restart: close store1
    store1.close();

    // Session 2: Server reboots with same SQLite file
    const store2 = new ChallengeStore(tempDbPath);

    // Replay attack attempt: Transaction must STILL be marked as redeemed!
    expect(store2.isTxRedeemed(dummyTx)).toBe(true);
    expect(store2.isChallengeRedeemed(challenge.challengeId)).toBe(true);
    // Challenge should not be active for a second claim
    expect(store2.getChallenge(challenge.challengeId)).toBeUndefined();

    store2.close();
  });

  it('expires unredeemed challenges when TTL passes', async () => {
    const store = new ChallengeStore(tempDbPath, 15);
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.01',
      'XLM',
      '/api',
      'testnet',
      undefined,
      15 // 15ms TTL
    );

    await new Promise((r) => setTimeout(r, 35));
    const expired = store.getChallenge(challenge.challengeId);
    expect(expired).toBeUndefined();

    store.close();
  });

  it('guarantees atomic rollback on duplicate transaction hash replay', () => {
    const store = new ChallengeStore(tempDbPath);
    const txHash = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

    const challenge1 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource-1'
    );
    const challenge2 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource-2'
    );

    // First redemption succeeds
    store.markRedeemed(challenge1.challengeId, txHash);
    expect(store.isChallengeRedeemed(challenge1.challengeId)).toBe(true);
    expect(store.isTxRedeemed(txHash)).toBe(true);

    // Second redemption with SAME txHash MUST throw and roll back challenge2
    expect(() => {
      store.markRedeemed(challenge2.challengeId, txHash);
    }).toThrow();

    // Verify ACID rollback: challenge2 was NOT marked as redeemed!
    expect(store.isChallengeRedeemed(challenge2.challengeId)).toBe(false);
    expect(store.getChallenge(challenge2.challengeId)).toBeDefined();

    store.close();
  });

  it('rejects double redemption of the same challenge', () => {
    const store = new ChallengeStore(tempDbPath);
    const tx1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tx2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );

    store.markRedeemed(challenge.challengeId, tx1);

    expect(() => {
      store.markRedeemed(challenge.challengeId, tx2);
    }).toThrow(/already redeemed/i);

    expect(store.isTxRedeemed(tx2)).toBe(false);

    store.close();
  });
});
