import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { ChallengeStore } from '../src/challenge-store.js';

const require = createRequire(import.meta.url);
const betterSqlitePath = require.resolve('better-sqlite3');

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
    const store1 = new ChallengeStore(tempDbPath, 60_000);
    const challenge = store1.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/test-resource'
    );

    expect(store1.isTxRedeemed(dummyTx)).toBe(false);
    expect(store1.isChallengeRedeemed(challenge.challengeId)).toBe(false);

    store1.markRedeemed(challenge.challengeId, dummyTx);

    expect(store1.isTxRedeemed(dummyTx)).toBe(true);
    expect(store1.isChallengeRedeemed(challenge.challengeId)).toBe(true);

    // Verify challenge cannot be fetched again once redeemed
    expect(store1.getChallenge(challenge.challengeId)).toBeUndefined();

    // Verify double-redemption throws
    expect(() => store1.markRedeemed(challenge.challengeId, dummyTx)).toThrow();

    store1.close();

    // Session 2: Server restarts, opens same database file
    const store2 = new ChallengeStore(tempDbPath, 60_000);

    // Transaction hash MUST still be recognized as redeemed (prevents replay attack)
    expect(store2.isTxRedeemed(dummyTx)).toBe(true);
    expect(store2.isChallengeRedeemed(challenge.challengeId)).toBe(true);

    // Replay attempt MUST throw ACID constraint error
    expect(() => store2.markRedeemed(challenge.challengeId, dummyTx)).toThrow();

    store2.close();
  });

  it('handles expired challenges correctly', async () => {
    // Challenge with 10ms TTL
    const store = new ChallengeStore(tempDbPath, 10);
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/test-resource',
      'testnet',
      undefined,
      10
    );

    // Immediate check: still valid
    expect(store.getChallenge(challenge.challengeId)).toBeDefined();

    // Wait for TTL expiration
    await new Promise((r) => setTimeout(r, 20));

    // After expiration: getChallenge returns undefined
    expect(store.getChallenge(challenge.challengeId)).toBeUndefined();

    store.cleanupExpired();
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);

    store.close();
  });

  it('rejects duplicate transaction redemptions with identical hash (Anti-Double Spend)', () => {
    const store = new ChallengeStore(tempDbPath, 60_000);
    const c1 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/res-1'
    );
    const c2 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/res-2'
    );

    const txHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    // Redeem c1 with txHash: must succeed
    store.markRedeemed(c1.challengeId, txHash);
    expect(store.isTxRedeemed(txHash)).toBe(true);

    // Attempt to redeem c2 with SAME txHash: MUST throw and abort
    expect(() => store.markRedeemed(c2.challengeId, txHash)).toThrow();

    // Verify c2 was NOT marked as redeemed
    expect(store.isChallengeRedeemed(c2.challengeId)).toBe(false);

    store.close();
  });

  it('rejects redemption under real multi-threaded writer contention when challenge expires while waiting for locked immediate transaction', async () => {
    const store = new ChallengeStore(tempDbPath, 100);

    // Challenge with 120ms TTL
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/test-resource',
      'testnet',
      undefined,
      120 // 120ms TTL
    );

    const txHashContention = 'f'.repeat(64);

    // Worker code running in a genuine separate OS thread with independent SQLite connection
    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.betterSqlitePath);
      const db = new Database(workerData.tempDbPath, { timeout: 10000 });
      db.pragma('journal_mode = WAL');

      // Acquire exclusive write lock immediately via BEGIN IMMEDIATE
      const lockTx = db.transaction(() => {
        parentPort.postMessage({ type: 'LOCK_ACQUIRED' });
        const start = Date.now();
        // Hold exclusive write lock for 160ms (well past the 120ms challenge TTL)
        while (Date.now() - start < 160) {}
      });

      lockTx.immediate();
      parentPort.postMessage({ type: 'LOCK_RELEASED' });
      db.close();
    `;

    const worker = new Worker(workerScript, {
      eval: true,
      workerData: { tempDbPath, betterSqlitePath },
    });

    let mainThreadWaitTime = 0;
    let mainThreadError: unknown = null;

    await new Promise<void>((resolve, reject) => {
      worker.on('message', (msg) => {
        if (msg.type === 'LOCK_ACQUIRED') {
          const t0 = Date.now();
          // At this exact moment, Worker thread holds the exclusive write lock and challenge is NOT yet expired (e.g. at ~10ms of 120ms TTL).
          // Main thread attempts markRedeemed. SQLite blocks main thread waiting for worker's write lock to release.
          try {
            store.markRedeemed(challenge.challengeId, txHashContention);
          } catch (err) {
            mainThreadError = err;
          } finally {
            mainThreadWaitTime = Date.now() - t0;
          }
        } else if (msg.type === 'LOCK_RELEASED') {
          resolve();
        }
      });

      worker.on('error', reject);
    });

    await worker.terminate();

    // 1. Assert main thread genuinely waited for worker's lock (> 100ms)
    expect(mainThreadWaitTime).toBeGreaterThanOrEqual(100);

    // 2. Assert markRedeemed failed specifically with expiration error (not SQLITE_BUSY, because timeout is generous)
    expect(mainThreadError).toBeDefined();
    expect((mainThreadError as Error).message).toContain('expired');

    // 3. Strict invariants: neither the tx hash nor the challenge is redeemed
    expect(store.isTxRedeemed(txHashContention)).toBe(false);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);

    store.close();
  });
});
