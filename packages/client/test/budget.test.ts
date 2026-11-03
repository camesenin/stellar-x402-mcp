import { describe, it, expect } from 'vitest';
import { BudgetManager } from '../src/budget.js';

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

    // Advance 60_001 ms
    mockTime += 60_001;
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

    budget.resolveQuarantine(res2, 'NOT_FOUND');
    expect(budget.getPendingReservedXlm()).toBe(0);
    // Spending total remains 0.6, res2 budget was freed without charge
    expect(budget.getSpentTotal()).toBe(0.6);
  });
});
