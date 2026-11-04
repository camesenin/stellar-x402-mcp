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
    let store: ChallengeStore | null = null;
    let worker: Worker | null = null;
    const txHashContention = 'f'.repeat(64);

    let mainThreadWaitTime = 0;
    let mainThreadError: unknown = null;
    let challengeId = '';
    let preCheckExpired = true;
    let postWaitExpired = false;

    try {
      store = new ChallengeStore(tempDbPath, 100, 10_000);

      // Worker script running in a genuine separate OS thread with independent SQLite connection
      const workerScript = `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.betterSqlitePath);
        const db = new Database(workerData.tempDbPath, { timeout: 10000 });
        db.pragma('journal_mode = WAL');

        parentPort.on('message', (cmd) => {
          if (cmd && typeof cmd === 'object' && cmd.type === 'START_LOCK') {
            const lockTx = db.transaction(() => {
              parentPort.postMessage({ type: 'LOCK_ACQUIRED' });
              const start = Date.now();
              // Hold exclusive write lock for 180ms
              while (Date.now() - start < 180) {}
            });
            lockTx.immediate();
            parentPort.postMessage({ type: 'LOCK_RELEASED' });
            db.close();
          }
        });

        parentPort.postMessage({ type: 'WORKER_READY' });
      `;

      worker = new Worker(workerScript, {
        eval: true,
        workerData: { tempDbPath, betterSqlitePath },
      });

      // 1. Wait for Worker to initialize connection and report WORKER_READY (with 3s deadline & exit guard)
      await new Promise<void>((resolve, reject) => {
        let isSettled = false;
        let deadlineTimer: NodeJS.Timeout | null = null;

        const settle = (err?: Error | null) => {
          if (isSettled) return;
          isSettled = true;
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (worker) {
            worker.off('message', onMessage);
            worker.off('exit', onExit);
            worker.off('error', onError);
          }
          if (err) reject(err);
          else resolve();
        };

        const onExit = (code: number) => {
          settle(new Error(`Worker exited prematurely before ready with code ${code}`));
        };
        const onError = (err: Error) => {
          settle(err);
        };
        const onMessage = (msg: unknown) => {
          try {
            if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'WORKER_READY') {
              settle(null);
            } else {
              settle(new Error('Unexpected worker initial message: ' + JSON.stringify(msg)));
            }
          } catch (listenerErr) {
            settle(listenerErr instanceof Error ? listenerErr : new Error(String(listenerErr)));
          }
        };

        deadlineTimer = setTimeout(() => {
          settle(new Error('Worker initialization timed out after 3000ms'));
        }, 3_000);

        worker.on('message', onMessage);
        worker.once('exit', onExit);
        worker.once('error', onError);
      });

      // 2. NOW create challenge with 120ms TTL (Worker is confirmed hot and ready)
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/test-resource',
        'testnet',
        undefined,
        120 // 120ms TTL
      );
      challengeId = challenge.challengeId;

      // 3. Command Worker to acquire write lock and wait for LOCK_ACQUIRED -> LOCK_RELEASED
      await new Promise<void>((resolve, reject) => {
        let isSettled = false;
        let deadlineTimer: NodeJS.Timeout | null = null;

        const settle = (err?: Error | null) => {
          if (isSettled) return;
          isSettled = true;
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (worker) {
            worker.off('message', onMessage);
            worker.off('exit', onExit);
            worker.off('error', onError);
          }
          if (err) reject(err);
          else resolve();
        };

        const onExit = (code: number) => {
          settle(new Error(`Worker exited prematurely during lock lifecycle with code ${code}`));
        };
        const onError = (err: Error) => {
          settle(err);
        };
        const onMessage = (msg: unknown) => {
          try {
            if (typeof msg !== 'object' || msg === null) return;
            const typedMsg = msg as { type?: string };

            if (typedMsg.type === 'LOCK_ACQUIRED') {
              // Precondition Check: Challenge MUST be fresh and NOT expired when entering markRedeemed
              const tEntry = Date.now();
              preCheckExpired = tEntry > challenge.expiresAt;
              if (preCheckExpired) {
                throw new Error(`Precondition failure: Challenge was already expired before markRedeemed called (tEntry=${tEntry}, expiresAt=${challenge.expiresAt})`);
              }

              // Attempt markRedeemed on main thread. Main thread is genuinely blocked waiting for Worker write lock
              try {
                store!.markRedeemed(challenge.challengeId, txHashContention);
              } catch (err) {
                mainThreadError = err;
              } finally {
                const tExit = Date.now();
                mainThreadWaitTime = tExit - tEntry;
                postWaitExpired = tExit > challenge.expiresAt;
              }
            } else if (typedMsg.type === 'LOCK_RELEASED') {
              settle(null);
            }
          } catch (listenerErr) {
            settle(listenerErr instanceof Error ? listenerErr : new Error(String(listenerErr)));
          }
        };

        deadlineTimer = setTimeout(() => {
          settle(new Error('Contention lifecycle timed out after 5000ms'));
        }, 5_000);

        worker!.on('message', onMessage);
        worker!.once('exit', onExit);
        worker!.once('error', onError);
        worker!.postMessage({ type: 'START_LOCK' });
      });
    } finally {
      // Robust termination & store closure: race worker termination against 2000ms timeout
      try {
        if (worker) {
          await Promise.race([
            worker.terminate(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Worker terminate timed out after 2000ms')), 2000)),
          ]).catch(() => {});
        }
      } finally {
        if (store) {
          store.close();
        }
      }
    }

    // Assertions verifying genuine race & postconditions:
    // a) Proves challenge was fresh and unexpired when entering markRedeemed
    expect(preCheckExpired).toBe(false);

    // b) Proves main thread genuinely waited for worker lock at SQLite engine level (> 100ms)
    expect(mainThreadWaitTime).toBeGreaterThanOrEqual(100);

    // c) Proves challenge expired during the lock wait before acquisition
    expect(postWaitExpired).toBe(true);

    // d) Proves markRedeemed failed specifically with atomic expiration error
    expect(mainThreadError).toBeDefined();
    expect((mainThreadError as Error).message).toContain('expired');

    // e) Direct DB query protected with its own try/finally:
    const verifyStore = new ChallengeStore(tempDbPath);
    try {
      const rawDb = (verifyStore as any).db;
      const challengeRow = rawDb.prepare('SELECT challenge_id, is_redeemed, expires_at FROM challenges WHERE challenge_id = ?').get(challengeId);
      expect(challengeRow).toBeDefined();
      expect(challengeRow.is_redeemed).toBe(0);
      expect(challengeRow.expires_at).toBeLessThanOrEqual(Date.now());

      const redeemedRow = rawDb.prepare('SELECT tx_hash FROM redeemed_transactions WHERE tx_hash = ?').get(txHashContention);
      expect(redeemedRow).toBeUndefined();
    } finally {
      verifyStore.close();
    }
  }, 15_000);
});
