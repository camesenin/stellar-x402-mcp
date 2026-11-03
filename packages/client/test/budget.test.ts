import { describe, it, expect } from 'vitest';
import { BudgetManager, xlmToStroopsBigInt } from '../src/budget.js';

describe('BudgetManager', () => {
  it('allows payments below per-call and cumulative ceiling', () => {
    const budget = new BudgetManager(0.5, 2.0);

    const check1 = budget.canAfford(0.1);
    expect(check1.allowed).toBe(true);

    budget.recordPayment(0.1, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'tx1');
    expect(budget.getSpentTotal()).toBe(0.1);

    const check2 = budget.canAfford(0.3);
    expect(check2.allowed).toBe(true);
  });

  it('rejects payments exceeding per-call limit', () => {
    const budget = new BudgetManager(0.5, 2.0);
    const check = budget.canAfford(0.6);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('exceeds per-call limit');
  });

  it('rejects payments exceeding cumulative budget limit', () => {
    const budget = new BudgetManager(1.0, 1.5);
    budget.recordPayment(0.9, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'tx1');

    const check = budget.canAfford(0.8);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('would exceed total ceiling');
  });

  it('keeps track of payment receipts', () => {
    const budget = new BudgetManager(5.0, 10.0);
    budget.recordPayment(0.5, 'GDEST1', 'tx100');
    budget.recordPayment(0.2, 'GDEST2', 'tx101');

    const receipts = budget.getReceipts();
    expect(receipts).toHaveLength(2);
    expect(receipts[0].amount).toBe(0.5);
    expect(receipts[0].destination).toBe('GDEST1');
    expect(receipts[0].txHash).toBe('tx100');
  });

  it('atomically reserves budget under concurrency and prevents overdraft', () => {
    const budget = new BudgetManager(1.0, 1.5);

    // Call 1 reserves 0.8 XLM
    const resId1 = budget.reserve(0.8);
    expect(resId1).toBeDefined();
    expect(budget.getPendingReservedXlm()).toBe(0.8);

    // Call 2 tries to reserve 0.8 XLM -> total 1.6 > 1.5 -> must fail!
    expect(() => budget.reserve(0.8)).toThrow(/Budget reservation rejected/);

    // Call 1 completes on ledger
    budget.finalize(resId1, 'GDEST1', 'tx123');
    expect(budget.getPendingReservedXlm()).toBe(0);
    expect(budget.getSpentTotal()).toBe(0.8);

    // Now remaining budget is 1.5 - 0.8 = 0.7. Try reserve 0.5 -> succeeds!
    const resId2 = budget.reserve(0.5);
    expect(budget.getPendingReservedXlm()).toBe(0.5);

    // Call 2 fails or is aborted -> release reservation
    budget.release(resId2);
    expect(budget.getPendingReservedXlm()).toBe(0);
    expect(budget.getSpentTotal()).toBe(0.8);
  });

  it('quarantines reservation when released with in-flight timebound to prevent overdraft', () => {
    let mockTime = 1000;
    const budget = new BudgetManager(1.0, 1.5, 120_000, () => mockTime);

    // Reserve 0.8 XLM
    const resId = budget.reserve(0.8);
    expect(budget.getPendingReservedXlm()).toBe(0.8);

    // Release called because RPC poll timed out, but tx has maxTime bound of mockTime + 30_000
    const inFlightUntil = mockTime + 30_000;
    budget.release(resId, inFlightUntil);

    // Reservation is NOT freed immediately: still quarantined in pending status
    expect(budget.getPendingReservedXlm()).toBe(0.8);

    // A competing call attempting to reserve 0.8 XLM is still blocked!
    expect(() => budget.reserve(0.8)).toThrow(/would exceed total ceiling/);

    // Advance clock past the in-flight timebound + 15s ledger clock-skew safety margin
    mockTime += 45_001;

    // Now reservation is pruned and budget is freed safely
    expect(budget.getPendingReservedXlm()).toBe(0);
    const newRes = budget.reserve(0.8);
    expect(newRes).toBeDefined();
  });

  it('applies default 60s safety quarantine when release is called with maxTime=0', () => {
    let mockTime = 5000;
    const budget = new BudgetManager(1.0, 1.5, 120_000, () => mockTime);

    const resId = budget.reserve(0.5);
    // Release with maxTime=0 or undefined in-flight bound
    budget.release(resId, 0);

    // Still quarantined by default 60s
    expect(budget.getPendingReservedXlm()).toBe(0.5);

    // Advance 60s quarantine + 15s clock skew safety margin
    mockTime += 75_001;
    expect(budget.getPendingReservedXlm()).toBe(0);
  });

  it('reconciles quarantined reservation: SUCCESS records spending, NOT_FOUND frees budget', () => {
    let mockTime = 1000;
    const budget = new BudgetManager(1.0, 2.0, 120_000, () => mockTime);

    // Case 1: In-flight tx lands on ledger (SUCCESS)
    const res1 = budget.reserve(0.6);
    budget.release(res1, mockTime + 20_000, 'tx_landing_success', 'GMERCHANT_1');
    expect(budget.getQuarantinedReservations().length).toBe(1);

    budget.resolveQuarantine(res1, 'SUCCESS');
    expect(budget.getPendingReservedXlm()).toBe(0);
    expect(budget.getSpentTotal()).toBe(0.6);
    expect(budget.getReceipts()[0].txHash).toBe('tx_landing_success');

    // Case 2: In-flight tx expired on ledger (NOT_FOUND / FAILED)
    const res2 = budget.reserve(0.8);
    budget.release(res2, mockTime + 20_000, 'tx_dropped_never_landed', 'GMERCHANT_2');
    expect(budget.getPendingReservedXlm()).toBe(0.8);

    // Guard check: cannot unquarantine with NOT_FOUND before timeout boundary elapses
    expect(() => budget.resolveQuarantine(res2, 'NOT_FOUND')).toThrow(/Cannot release quarantined reservation/);

    // Advance clock past releaseAt (20s + 15s clock skew = 35_000ms)
    mockTime += 36_000;
    budget.resolveQuarantine(res2, 'NOT_FOUND');
    expect(budget.getPendingReservedXlm()).toBe(0);
    // Spending total remains 0.6, res2 budget was freed without charge
    expect(budget.getSpentTotal()).toBe(0.6);
  });

  it('protects in-flight tx with txHash from silent lazy pruning when timeout elapses without resolution', () => {
    let mockTime = 1000;
    const budget = new BudgetManager(1.0, 2.0, 120_000, () => mockTime);

    const res = budget.reserve(0.5);
    budget.release(res, mockTime + 10_000, 'tx_broadcast_inflight', 'GMERCHANT_3');

    // Advance clock past releaseAt
    mockTime += 30_000;

    // Because txHash is attached, lazy pruning does NOT silently delete it!
    expect(budget.getPendingReservedXlm()).toBe(0.5);
    expect(budget.getQuarantinedReservations().length).toBe(1);

    // Explicit resolution frees it safely
    budget.resolveQuarantine(res, 'NOT_FOUND');
    expect(budget.getPendingReservedXlm()).toBe(0);
  });

  it('validates numeric format in xlmToStroopsBigInt rejecting NaN, negatives and excess decimals', () => {
    expect(() => xlmToStroopsBigInt('NaN')).toThrow(/Expected valid numeric string/);
    expect(() => xlmToStroopsBigInt('-0.5')).toThrow(/Amount must be positive/);
    expect(() => xlmToStroopsBigInt('0.12345678')).toThrow(/Excess decimal precision/);
    expect(xlmToStroopsBigInt('1.5')).toBe(15_000_000n);
    expect(xlmToStroopsBigInt(10_000_000n)).toBe(10_000_000n);
  });

  it('reconciles quarantined pool automatically via status checker callback', async () => {
    let mockTime = 1000;
    const budget = new BudgetManager(1.0, 5.0, 120_000, () => mockTime);

    const r1 = budget.reserve(0.5);
    budget.release(r1, mockTime + 5000, 'tx_hash_confirmed', 'GMERCHANT_1');

    const r2 = budget.reserve(0.8);
    budget.release(r2, mockTime + 5000, 'tx_hash_dropped', 'GMERCHANT_2');

    // Advance past timeout boundary
    mockTime += 25_000;

    const mockChecker = async (hash: string): Promise<'SUCCESS' | 'FAILED' | 'NOT_FOUND'> => {
      if (hash === 'tx_hash_confirmed') return 'SUCCESS';
      return 'NOT_FOUND';
    };

    const result = await budget.reconcileQuarantinedPool(mockChecker);
    expect(result.resolved).toBe(2);
    expect(budget.getPendingReservedXlm()).toBe(0);
    expect(budget.getSpentTotal()).toBe(0.5);
  });

  it('enforces RPC retention window guards for NOT_FOUND: prevents unquarantining if node is behind or pruned', () => {
    let mockTime = 100_000;
    const budget = new BudgetManager(1.0, 5.0, 120_000, () => mockTime);

    // Reservation with maxTime = 110_000ms (110s) -> releaseAt = 125_000ms
    const r = budget.reserve(0.5);
    budget.release(r, 110_000, 'tx_hash_window_check', 'GMERCHANT_1');

    // Advance clock past releaseAt (e.g. 130_000ms)
    mockTime = 130_000;

    // Subcase A: RPC node latestLedgerCloseTime is 105s (behind tx maxTime 110s)
    // Even though local clock passed releaseAt, RPC node is behind! Tx could still land!
    budget.resolveQuarantine(r, {
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 105,
      oldestLedgerCloseTime: 90,
    });
    // Reservation must NOT be freed!
    expect(budget.getPendingReservedXlm()).toBe(0.5);

    // Subcase B: RPC node has evicted tx validity window (oldestLedgerCloseTime 115s > maxTime 110s)
    // NOT_FOUND could be an eviction artifact; fail-closed!
    budget.resolveQuarantine(r, {
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 140,
      oldestLedgerCloseTime: 115,
    });
    // Reservation must STILL NOT be freed!
    expect(budget.getPendingReservedXlm()).toBe(0.5);

    // Subcase C: Verified within retention window: latest (120s) > maxTime (110s) AND oldest (100s) <= maxTime (110s)
    budget.resolveQuarantine(r, {
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 120,
      oldestLedgerCloseTime: 100,
    });
    // Now definitively confirmed expired without inclusion! Budget freed!
    expect(budget.getPendingReservedXlm()).toBe(0);
  });

  it('manages active background reconciler lifecycle via startActiveReconciler and stopActiveReconciler', async () => {
    let mockTime = 1000;
    const budget = new BudgetManager(1.0, 5.0, 120_000, () => mockTime);
    const r = budget.reserve(0.1);
    budget.release(r, mockTime + 100, 'tx_reconciler_test', 'GMERCHANT');
    // Advance past releaseAt so the reconciler inspects on-chain status
    mockTime += 20_000;

    let checkCalls = 0;
    const mockChecker = async () => {
      checkCalls++;
      return 'PENDING' as const;
    };

    budget.startActiveReconciler(mockChecker, 30);
    await new Promise((resolve) => setTimeout(resolve, 100));
    budget.stopActiveReconciler();

    const currentCalls = checkCalls;
    expect(currentCalls).toBeGreaterThanOrEqual(1);

    // Verify timer stopped
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(checkCalls).toBe(currentCalls);
  });
});
