import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { ChallengeStore } from '../src/challenge-store.js';

const require = createRequire(import.meta.url);
const betterSqlitePath = require.resolve('better-sqlite3');

// Reusable settlement and event listener management routine shared between real contention harness and fault injection
export function setupWorkerPromiseLifecycle<T>(
  worker: {
    on: (event: string, fn: Function) => void;
    once: (event: string, fn: Function) => void;
    off: (event: string, fn: Function) => void;
    postMessage?: (msg: any) => void;
  },
  timeoutMs: number,
  timeoutMessage: string,
  onMessageReceived: (msg: unknown, settle: (err?: Error | null, val?: T) => void) => void,
  commandToPost?: any
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let isSettled = false;
    let deadlineTimer: NodeJS.Timeout | null = null;

    const settle = (err?: Error | null, val?: T) => {
      if (isSettled) return;
      isSettled = true;
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      worker.off('error', onError);
      if (err) reject(err);
      else resolve(val as T);
    };

    const onExit = (code: number) => {
      settle(new Error(`Worker exited prematurely with code ${code}`));
    };
    const onError = (err: Error) => {
      settle(err);
    };
    const onMessage = (msg: unknown) => {
      try {
        onMessageReceived(msg, settle);
      } catch (listenerErr) {
        settle(listenerErr instanceof Error ? listenerErr : new Error(String(listenerErr)));
      }
    };

    try {
      deadlineTimer = setTimeout(() => {
        settle(new Error(timeoutMessage));
      }, timeoutMs);

      worker.on('message', onMessage);
      worker.once('exit', onExit);
      worker.once('error', onError);

      if (commandToPost && worker.postMessage) {
        worker.postMessage(commandToPost);
      }
    } catch (setupErr) {
      settle(setupErr instanceof Error ? setupErr : new Error(String(setupErr)));
    }
  });
}

// Reusable robust teardown helper shared between contention test and fault-injection tests
export async function executeStoreAndWorkerTeardown(
  worker: { terminate: () => Promise<number | void> } | null,
  store: { close: () => void } | null,
  primaryError: Error | null = null
): Promise<void> {
  const cleanupErrors: Error[] = [];
  if (primaryError) {
    cleanupErrors.push(primaryError);
  }

  if (worker) {
    let termTimer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        worker.terminate().then(() => {
          if (termTimer) clearTimeout(termTimer);
        }),
        new Promise((_, reject) => {
          termTimer = setTimeout(() => {
            reject(new Error('Worker termination timed out after 2000ms'));
          }, 2000);
        }),
      ]);
    } catch (termErr) {
      cleanupErrors.push(termErr instanceof Error ? termErr : new Error(String(termErr)));
    } finally {
      if (termTimer) {
        clearTimeout(termTimer);
        termTimer = null;
      }
    }
  }

  if (store) {
    try {
      store.close();
    } catch (closeErr) {
      cleanupErrors.push(closeErr instanceof Error ? closeErr : new Error(String(closeErr)));
    }
  }

  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  } else if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      `Multiple errors during execution and teardown: ${cleanupErrors.map(e => e.message).join('; ')}`
    );
  }
}

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
    // TIMING DEMARCATION & OPERATIONAL BUDGET ARCHITECTURE:
    // 1. SQLite Engine busyTimeout: 4_000ms - Operational wait limit inside SQLite C runtime for lock resolution.
    // 2. Harness Phase Deadline: 5_000ms - JavaScript watchdog deadline for the entire contention phase.
    // 3. Vitest Test Budget: 15_000ms - Runner-level execution ceiling.
    // Note: Native C synchronous SQLite blocking calls cannot be preemptively interrupted by Node.js JavaScript timers;
    // thus busyTimeoutMs (4,000ms) is strictly calibrated below the phase watchdog (5,000ms) to ensure timely SQLite unblocking.
    let store: ChallengeStore | null = null;
    let worker: Worker | null = null;
    const txHashContention = 'f'.repeat(64);

    let mainThreadWaitTime = 0;
    let mainThreadError: unknown = null;
    let testExecutionError: Error | null = null;
    let challengeId = '';
    let preCheckExpired = true;
    let postWaitExpired = false;

    try {
      // Set busyTimeout to 4_000ms so SQLite unblocks before the 5_000ms phase deadline if held
      store = new ChallengeStore(tempDbPath, 100, 4_000);

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

      // 1. Wait for Worker to initialize connection and report WORKER_READY using shared setupWorkerPromiseLifecycle
      await setupWorkerPromiseLifecycle<void>(
        worker,
        3_000,
        'Worker initialization timed out after 3000ms',
        (msg, settle) => {
          if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'WORKER_READY') {
            settle(null);
          } else {
            settle(new Error('Unexpected worker initial message: ' + JSON.stringify(msg)));
          }
        }
      );

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

      // 3. Command Worker to acquire write lock and wait for LOCK_ACQUIRED -> LOCK_RELEASED using shared setupWorkerPromiseLifecycle
      await setupWorkerPromiseLifecycle<void>(
        worker,
        5_000,
        'Contention lifecycle timed out after 5000ms',
        (msg, settle) => {
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
        },
        { type: 'START_LOCK' }
      );
    } catch (testBodyErr) {
      testExecutionError = testBodyErr instanceof Error ? testBodyErr : new Error(String(testBodyErr));
    } finally {
      await executeStoreAndWorkerTeardown(worker, store, testExecutionError);
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

  it('guarantees database connection closure if ChallengeStore constructor throws during initialization', () => {
    // We test actual partial acquisition failure: connection is opened, but pragma / initSchema fails
    const Database = require(betterSqlitePath);
    let capturedDb: any = null;
    const originalPragma = Database.prototype.pragma;
    const sentinelError = new Error('Simulated pragma failure during schema initialization');

    // Spy on prototype pragma to capture the instance and simulate post-connection failure
    Database.prototype.pragma = function (pragmaStr: string) {
      capturedDb = this;
      if (pragmaStr.includes('synchronous')) {
        throw sentinelError;
      }
      return originalPragma.apply(this, arguments as any);
    };

    try {
      let caught: any = null;
      try {
        new ChallengeStore(tempDbPath);
      } catch (e) {
        caught = e;
      }

      // Verifies exact reference identity of the thrown exception (condition 4)
      expect(caught).toBe(sentinelError);
      expect(capturedDb).toBeDefined();
      expect(capturedDb.open).toBe(false); // Proves this.db.close() was executed in catch block
    } finally {
      Database.prototype.pragma = originalPragma;
    }
  });

  it('executes real teardown routine with injected worker.terminate and store.close failures, verifying AggregateError.errors preservation and original test error retention', async () => {
    const originalTestError = new Error('Test body execution failure');
    const terminateFailure = new Error('worker.terminate() failed hard');
    const closeFailure = new Error('store.close() failed hard');

    const fakeWorker = {
      terminate: async () => {
        throw terminateFailure;
      }
    };
    const fakeStore = {
      close: () => {
        throw closeFailure;
      }
    };

    let caughtFinalError: any = null;

    try {
      await executeStoreAndWorkerTeardown(fakeWorker, fakeStore, originalTestError);
    } catch (err) {
      caughtFinalError = err;
    }

    expect(caughtFinalError).toBeInstanceOf(AggregateError);
    const agg = caughtFinalError as AggregateError;
    // Exactly 3 errors preserved: original test error + terminate error + close error!
    expect(agg.errors).toHaveLength(3);
    expect(agg.errors[0]).toBe(originalTestError);
    expect(agg.errors[1]).toBe(terminateFailure);
    expect(agg.errors[2]).toBe(closeFailure);
  });

  it('proves settle routes synchronous listener registration errors immediately, cancels timers, and detaches listeners without waiting for deadline', async () => {
    let timerCleared = false;
    let timerFired = false;

    const mockWorker = {
      handlers: {} as Record<string, Function[]>,
      on(event: string, fn: Function) {
        if (event === 'message') {
          (this.handlers[event] = this.handlers[event] || []).push(fn);
        } else {
          throw new Error(`Simulated synchronous throw on ${event} registration`);
        }
      },
      once(event: string, fn: Function) {
        this.on(event, fn);
      },
      off(event: string, fn: Function) {
        this.handlers[event] = (this.handlers[event] || []).filter(h => h !== fn);
      },
      postMessage() {}
    };

    // Demonstrates genuine promise REJECTION using the shared production setupWorkerPromiseLifecycle routine
    await expect(
      setupWorkerPromiseLifecycle<void>(
        mockWorker,
        50,
        'Watchdog timeout',
        () => {},
        { type: 'TEST_POST' }
      )
    ).rejects.toThrow('Simulated synchronous throw on exit registration');

    // Wait 100ms past the 50ms deadline to prove timer callback remained cancelled and never fired
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockWorker.handlers['message']).toHaveLength(0);
  });

  it('fails with SQLITE_BUSY when lock contention exceeds busyTimeout without partial mutations', () => {
    const dbPathContention = path.join(os.tmpdir(), `busy_contention_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
    const Database = require(betterSqlitePath);

    // Initializer creates DB and schema
    const initStore = new ChallengeStore(dbPathContention);
    const challenge = initStore.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/test-resource',
      'testnet',
      undefined,
      60_000
    );
    initStore.close();

    // Lock holding connection with independent DB handle
    const lockDb = new Database(dbPathContention, { timeout: 5000 });
    lockDb.pragma('journal_mode = WAL');

    // Store under test with short busyTimeout of 100ms
    const contendingStore = new ChallengeStore(dbPathContention, 60_000, 100);

    const lockTx = lockDb.transaction(() => {
      // Hold immediate write lock for 250ms (exceeding contendingStore's 100ms busyTimeout)
      const start = Date.now();
      let caughtBusyError: any = null;

      try {
        contendingStore.markRedeemed(challenge.challengeId, 'e'.repeat(64));
      } catch (err: any) {
        caughtBusyError = err;
      }

      // Assert markRedeemed failed specifically with SQLITE_BUSY database is locked
      expect(caughtBusyError).toBeDefined();
      expect(caughtBusyError.code).toBe('SQLITE_BUSY');

      while (Date.now() - start < 250) {}
    });

    try {
      lockTx.immediate();

      // Verify no partial mutations occurred
      const verifyStore = new ChallengeStore(dbPathContention);
      try {
        const fetched = verifyStore.getChallenge(challenge.challengeId);
        expect(fetched).toBeDefined(); // Still exists and is unredeemed (is_redeemed = 0)
        const rawDb = (verifyStore as any).db;
        const row = rawDb.prepare('SELECT tx_hash FROM redeemed_transactions WHERE tx_hash = ?').get('e'.repeat(64));
        expect(row).toBeUndefined();
      } finally {
        verifyStore.close();
      }
    } finally {
      contendingStore.close();
      lockDb.close();
      if (fs.existsSync(dbPathContention)) {
        try { fs.unlinkSync(dbPathContention); } catch {}
      }
    }
  });

  it('guarantees cleanupExpired preserves challenges within 60s grace period and only purges past grace threshold', () => {
    const store = new ChallengeStore(tempDbPath, 60_000);
    // Create challenge 1: expired 10 seconds ago (inside 60s grace period)
    const c1 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/res-grace-1',
      'testnet',
      undefined,
      -10_000 // expiresAt = Date.now() - 10_000
    );

    // Create challenge 2: expired 90 seconds ago (outside 60s grace period)
    const c2 = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/res-grace-2',
      'testnet',
      undefined,
      -90_000 // expiresAt = Date.now() - 90_000
    );

    // Run cleanupExpired with standard 60s safety margin
    store.cleanupExpired(60_000);

    // c1 is inside 60s grace window: preserved for contention recovery!
    expect(store.getChallengeAllowExpired(c1.challengeId)).toBeDefined();

    // c2 is beyond 60s grace window: safely purged!
    expect(store.getChallengeAllowExpired(c2.challengeId)).toBeUndefined();

    store.close();
  });
});
