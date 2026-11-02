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
    expect(check.reason).toContain('exceed total budget limit');
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
});
