import crypto from 'node:crypto';

export interface ActiveReservation {
  id: string;
  amountStroops: bigint;
  reservedAt: number;
  releaseAt?: number;
  txHash?: string;
  destination?: string;
}

export type QuarantineTimeInput =
  | { epochMs: number }
  | { durationMs: number }
  | number; // explicit epochMs or relative seconds if < 100_000

export const STROOPS_PER_XLM = 10_000_000n;

export function xlmToStroopsBigInt(xlm: number | string | bigint): bigint {
  if (typeof xlm === 'bigint') {
    if (xlm <= 0n) throw new Error(`Payment amount must be positive, got ${xlm}`);
    return xlm;
  }
  const str = String(xlm).trim();
  if (!str || str.startsWith('-')) {
    throw new Error(`Invalid payment amount: '${xlm}'. Amount must be positive.`);
  }
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid payment amount format: '${xlm}'. Expected valid numeric string.`);
  }
  const [whole, fraction = ''] = str.split('.');
  if (fraction.length > 7) {
    throw new Error(
      `Excess decimal precision in '${xlm}'. Stellar supports at most 7 decimal places (stroops).`
    );
  }
  const padded = fraction.padEnd(7, '0');
  const stroops = BigInt(whole) * 10_000_000n + BigInt(padded);
  if (stroops <= 0n) {
    throw new Error(`Payment amount must be greater than zero stroops, got: '${xlm}'`);
  }
  return stroops;
}

export function stroopsToXlmNumber(stroops: bigint): number {
  return Number(stroops) / 10_000_000;
}

export interface TxStatusReport {
  status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'PENDING';
  latestLedgerCloseTime?: number; // epoch seconds
  oldestLedgerCloseTime?: number; // epoch seconds
}

export type StatusCheckerFn = (
  txHash: string
) => Promise<'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'PENDING' | TxStatusReport>;

export class BudgetManager {
  private totalSettledStroops: bigint = 0n;
  private reservations = new Map<string, ActiveReservation>();
  private receipts: Array<{
    amount: number;
    amountXlm: number;
    amountStroops: string;
    destination: string;
    timestamp: number;
    txHash: string;
  }> = [];

  private maxPerCallStroops: bigint;
  private totalCeilingStroops: bigint;
  private reconcilerTimer?: NodeJS.Timeout | ReturnType<typeof setInterval>;

  constructor(
    maxPerCallXlm: number = 1.0,
    totalCeilingXlm: number = 10.0,
    private reservationTtlMs: number = 120_000,
    private clock: () => number = () => Date.now()
  ) {
    this.maxPerCallStroops = xlmToStroopsBigInt(maxPerCallXlm);
    this.totalCeilingStroops = xlmToStroopsBigInt(totalCeilingXlm);
  }

  /**
   * Prunes expired unconfirmed reservations.
   * Invariants:
   * - If a reservation has a txHash (in-flight on network), it is NEVER silently pruned.
   *   It must be explicitly reconciled against on-chain status via resolveQuarantine().
   * - If a reservation has no txHash and was released with releaseAt, it is pruned once releaseAt passes.
   * - If a reservation was never finalized/released and TTL passes, it is pruned as abandoned.
   */
  private pruneExpiredReservations(): void {
    const now = this.clock();
    for (const [id, res] of this.reservations.entries()) {
      if (res.txHash) {
        // In-flight broadcast transaction: protect from silent unmetered pruning
        continue;
      }
      if (res.releaseAt) {
        if (now >= res.releaseAt) {
          this.reservations.delete(id);
        }
      } else if (now - res.reservedAt > this.reservationTtlMs) {
        this.reservations.delete(id);
      }
    }
  }

  public getPendingReservedStroops(): bigint {
    this.pruneExpiredReservations();
    let pending = 0n;
    for (const res of this.reservations.values()) {
      pending += res.amountStroops;
    }
    return pending;
  }

  public getPendingReservedXlm(): number {
    return stroopsToXlmNumber(this.getPendingReservedStroops());
  }

  public canAfford(amountXlm: number): { allowed: boolean; reason?: string } {
    if (amountXlm <= 0) {
      return { allowed: false, reason: 'Payment amount must be greater than zero' };
    }

    const requestedStroops = xlmToStroopsBigInt(amountXlm);

    if (requestedStroops > this.maxPerCallStroops) {
      return {
        allowed: false,
        reason: `Requested payment ${amountXlm} XLM exceeds per-call limit of ${stroopsToXlmNumber(this.maxPerCallStroops)} XLM`,
      };
    }

    const pendingReserved = this.getPendingReservedStroops();
    const projectedTotal = this.totalSettledStroops + pendingReserved + requestedStroops;

    if (projectedTotal > this.totalCeilingStroops) {
      return {
        allowed: false,
        reason: `Projected cumulative spending ${stroopsToXlmNumber(projectedTotal).toFixed(4)} XLM (settled: ${stroopsToXlmNumber(this.totalSettledStroops).toFixed(4)}, reserved: ${stroopsToXlmNumber(pendingReserved).toFixed(4)}) would exceed total ceiling of ${stroopsToXlmNumber(this.totalCeilingStroops)} XLM`,
      };
    }

    return { allowed: true };
  }

  /**
   * Concurrency-safe budget reservation.
   * Atomically locks exact stroops from total ceiling while transaction is prepared and submitted.
   */
  public reserve(amountXlm: number): string {
    const check = this.canAfford(amountXlm);
    if (!check.allowed) {
      throw new Error(`Budget reservation rejected: ${check.reason}`);
    }

    const reservationId = crypto.randomUUID();
    this.reservations.set(reservationId, {
      id: reservationId,
      amountStroops: xlmToStroopsBigInt(amountXlm),
      reservedAt: this.clock(),
    });

    return reservationId;
  }

  /**
   * Finalize reservation upon successful on-chain confirmation
   */
  public finalize(reservationId: string, destination: string, txHash: string): void {
    const res = this.reservations.get(reservationId);
    if (!res) return;

    this.reservations.delete(reservationId);
    this.totalSettledStroops += res.amountStroops;
    this.receipts.push({
      amount: stroopsToXlmNumber(res.amountStroops),
      amountXlm: stroopsToXlmNumber(res.amountStroops),
      amountStroops: res.amountStroops.toString(),
      destination,
      timestamp: this.clock(),
      txHash,
    });
  }

  /**
   * Quarantine a failed, timed-out or cancelled reservation.
   * If in-flight on ledger, keepUntil specifies the ledger maxTime validity boundary.
   */
  public release(
    reservationId: string,
    keepUntil?: QuarantineTimeInput,
    txHash?: string,
    destination?: string
  ): void {
    const res = this.reservations.get(reservationId);
    if (!res) return;

    if (txHash) res.txHash = txHash;
    if (destination) res.destination = destination;

    if (keepUntil !== undefined) {
      let targetEpochMs: number;
      if (typeof keepUntil === 'object') {
        if ('epochMs' in keepUntil) {
          targetEpochMs = keepUntil.epochMs;
        } else {
          targetEpochMs = this.clock() + keepUntil.durationMs;
        }
      } else if (typeof keepUntil === 'number') {
        // Explicit boundary: if > 1_000_000_000_000, epoch ms.
        // If between 1_000_000_000 and 10_000_000_000, epoch seconds.
        // If relative duration (< 100_000), interpret as delta seconds.
        if (keepUntil > 1_000_000_000_000) {
          targetEpochMs = keepUntil;
        } else if (keepUntil > 1_000_000_000) {
          targetEpochMs = keepUntil * 1000;
        } else if (keepUntil > 0 && keepUntil <= 600) {
          targetEpochMs = this.clock() + keepUntil * 1000;
        } else if (keepUntil > 600) {
          targetEpochMs = keepUntil;
        } else {
          targetEpochMs = this.clock() + 60_000;
        }
      } else {
        targetEpochMs = this.clock() + 60_000;
      }

      // Add 15s ledger clock-skew buffer
      const effectiveKeepUntil = targetEpochMs + 15_000;
      if (effectiveKeepUntil > this.clock()) {
        res.releaseAt = effectiveKeepUntil;
        return;
      }
    }

    // Only delete immediately if no txHash was broadcast
    if (!res.txHash) {
      this.reservations.delete(reservationId);
    }
  }

  public recordPayment(amountXlm: number, destination: string, txHash: string): void {
    const stroops = xlmToStroopsBigInt(amountXlm);
    this.totalSettledStroops += stroops;
    this.receipts.push({
      amount: amountXlm,
      amountXlm,
      amountStroops: stroops.toString(),
      destination,
      timestamp: this.clock(),
      txHash,
    });
  }

  /**
   * Reconciles a quarantined reservation after inspecting on-chain status.
   * Guarantees:
   * - Cannot unquarantine with NOT_FOUND/FAILED before releaseAt expiration.
   * - If SUCCESS: permanently converts reserved stroops into settled expenditure.
   * - If NOT_FOUND / FAILED (after releaseAt): safely frees budget reservation if within retention window.
   */
  public resolveQuarantine(
    reservationId: string,
    outcome: 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'PENDING' | TxStatusReport
  ): void {
    const res = this.reservations.get(reservationId);
    if (!res) return;

    const now = this.clock();

    let status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'PENDING';
    let latestLedgerCloseTime: number | undefined;
    let oldestLedgerCloseTime: number | undefined;

    if (typeof outcome === 'object') {
      status = outcome.status;
      latestLedgerCloseTime = outcome.latestLedgerCloseTime;
      oldestLedgerCloseTime = outcome.oldestLedgerCloseTime;
    } else {
      status = outcome;
    }

    if (status === 'PENDING') {
      return; // remains quarantined
    }

    // SEC-06 Guard: reject premature unquarantine of in-flight transaction
    if (status !== 'SUCCESS' && res.releaseAt && now < res.releaseAt) {
      throw new Error(
        `Cannot release quarantined reservation '${reservationId}' before in-flight timeout boundary has elapsed (releaseAt: ${res.releaseAt}, current: ${now})`
      );
    }

    // Soroban RPC Retention Window Guard for NOT_FOUND:
    // NOT_FOUND is only definitive proof of non-inclusion if:
    // 1) latestLedgerCloseTime > maxTime (releaseAt - 15s clock skew)
    // 2) oldestLedgerCloseTime <= maxTime (meaning the tx validity window has NOT fallen off the retention window into archival oblivion)
    if (status === 'NOT_FOUND' && res.releaseAt) {
      const maxTimeSec = Math.floor((res.releaseAt - 15_000) / 1000);
      if (latestLedgerCloseTime !== undefined && oldestLedgerCloseTime !== undefined) {
        if (latestLedgerCloseTime <= maxTimeSec) {
          // The network has not yet reached maxTime; tx could still be included in an upcoming block!
          return; // keep pending quarantined
        }
        if (oldestLedgerCloseTime > maxTimeSec) {
          // The tx maxTime is older than the oldest retained ledger in RPC; NOT_FOUND could be an eviction artifact!
          // Maintain quarantine to fail closed against double spending.
          return;
        }
      }
    }

    if (status === 'SUCCESS') {
      this.totalSettledStroops += res.amountStroops;
      if (res.txHash && res.destination) {
        this.receipts.push({
          amount: stroopsToXlmNumber(res.amountStroops),
          amountXlm: stroopsToXlmNumber(res.amountStroops),
          amountStroops: res.amountStroops.toString(),
          destination: res.destination,
          timestamp: now,
          txHash: res.txHash,
        });
      }
    }

    this.reservations.delete(reservationId);
  }

  /**
   * Active pool reconciler: queries an asynchronous transaction status checker for all
   * quarantined in-flight reservations and resolves them to prevent memory/budget leaks.
   */
  public async reconcileQuarantinedPool(
    statusChecker: StatusCheckerFn
  ): Promise<{ resolved: number; pending: number }> {
    const now = this.clock();
    let resolved = 0;
    let pending = 0;

    for (const [id, res] of Array.from(this.reservations.entries())) {
      if (res.txHash) {
        // If releaseAt boundary has elapsed, inspect on-chain status
        if (!res.releaseAt || now >= res.releaseAt) {
          try {
            const report = await statusChecker(res.txHash);
            const initialCount = this.reservations.size;
            this.resolveQuarantine(id, report);
            if (this.reservations.size < initialCount) {
              resolved++;
            } else {
              pending++;
            }
          } catch {
            pending++;
          }
        } else {
          pending++;
        }
      }
    }

    return { resolved, pending };
  }

  /**
   * Starts active background timer to periodically reconcile quarantined reservations.
   */
  public startActiveReconciler(
    statusChecker: StatusCheckerFn,
    intervalMs: number = 10_000
  ): void {
    if (this.reconcilerTimer) return;
    this.reconcilerTimer = setInterval(async () => {
      try {
        await this.reconcileQuarantinedPool(statusChecker);
      } catch {
        // Handled silently in background loop
      }
    }, intervalMs);
  }

  /**
   * Stops active background reconciler timer.
   */
  public stopActiveReconciler(): void {
    if (this.reconcilerTimer) {
      clearInterval(this.reconcilerTimer);
      this.reconcilerTimer = undefined;
    }
  }

  public getQuarantinedReservations(): Array<{
    id: string;
    amountXlm: number;
    txHash?: string;
    releaseAt?: number;
  }> {
    const list: Array<{
      id: string;
      amountXlm: number;
      txHash?: string;
      releaseAt?: number;
    }> = [];
    for (const res of this.reservations.values()) {
      if (res.releaseAt || res.txHash) {
        list.push({
          id: res.id,
          amountXlm: stroopsToXlmNumber(res.amountStroops),
          txHash: res.txHash,
          releaseAt: res.releaseAt,
        });
      }
    }
    return list;
  }

  public getSpentTotal(): number {
    return stroopsToXlmNumber(this.totalSettledStroops);
  }

  public getSpentStroops(): bigint {
    return this.totalSettledStroops;
  }

  public getReceipts() {
    return [...this.receipts];
  }
}
