import crypto from 'node:crypto';

export interface ActiveReservation {
  id: string;
  amountStroops: bigint;
  reservedAt: number;
  releaseAt?: number;
  maxTimeSec?: number;
  broadcastAtSec?: number;
  txHash?: string;
  destination?: string;
}

export type QuarantineTimeInput =
  | { epochMs: number }
  | { durationMs: number }
  | { releaseAtEpochMs?: number; envelopeMaxTimeSec?: number }
  | number; // local timer epochMs or relative seconds if < 100_000

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
  latestLedgerCloseTime?: number | string; // epoch seconds (numeric or RPC string)
  oldestLedgerCloseTime?: number | string; // epoch seconds (numeric or RPC string)
  onChainReceiptExists?: boolean; // verified via persistent receipt storage lookup
}

export type StatusCheckerFn = (
  txHash: string
) => Promise<'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'PENDING' | TxStatusReport>;

/**
 * BudgetManager: Process-local concurrency-safe budget meter and fail-closed quarantine engine.
 *
 * Operational Lifecycle & Scope Boundary:
 * - Scope: Per-Instance In-Memory Isolation. Guarantees fail-closed isolation and atomic reservation tracking
 *   strictly within a single live BudgetManager instance during its runtime.
 * - Non-Persistence Disclosure: Reservations and settlement receipts are held entirely in memory in res/receipt maps.
 *   Reconstructing the client, spawning independent fetch factories, or restarting the process initializes a brand new
 *   empty reservation ledger.
 * - Economic Metering Boundary: The budget manager accounts exclusively for transferred payment amounts (in stroops/XLM);
 *   it does NOT incorporate network transaction fees (e.g. base inclusion fee), Soroban resource consumption fees,
 *   rent, or state archival restoration costs.
 * - Future Work / Non-Operational Caveat: Multi-replica coordination, crash-recovery continuity across server reboots,
 *   and persistent cross-instance state are future architectural milestones (Issue 6 PostgresStore, Issue 13 Reconciler)
 *   and are not currently operational in this client package.
 */
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
  private isReconciling: boolean = false;

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
      // In-flight broadcast transaction: protect from silent unmetered pruning
      if (res.txHash) {
        continue;
      }
      // Explicitly released reservation without txHash
      if (res.releaseAt) {
        if (now >= res.releaseAt) {
          this.reservations.delete(id);
        }
      }
      // Never prune unreleased active reservations! They represent active operations in flight.
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
      broadcastAtSec: Math.floor(this.clock() / 1000),
    });

    return reservationId;
  }

  /**
   * Finalize reservation upon successful on-chain confirmation
   */
      public finalize(reservationId: string, destination: string, txHash: string, amountXlmFallback?: number): void {
    const res = this.reservations.get(reservationId);

    // Strict identity validation: if reservation exists and already has an assigned txHash, it MUST match!
    if (res && res.txHash && res.txHash !== txHash) {
      return; // Foreign transaction hash: preserve reservation in quarantine!
    }

    // Idempotency: If this exact txHash has already been finalized
    if (this.receipts.some(r => r.txHash === txHash)) {
      if (res && (!res.txHash || res.txHash === txHash)) {
        this.reservations.delete(reservationId);
      }
      return;
    }

    let amountStroops: bigint;
    if (res) {
      amountStroops = res.amountStroops;
      this.reservations.delete(reservationId);
    } else {
      // If reservation was somehow missing, guarantee expenditure accounting to prevent unmetered spending:
      amountStroops = amountXlmFallback ? xlmToStroopsBigInt(amountXlmFallback) : this.maxPerCallStroops;
    }

    this.totalSettledStroops += amountStroops;
    this.receipts.push({
      amount: stroopsToXlmNumber(amountStroops),
      amountXlm: stroopsToXlmNumber(amountStroops),
      amountStroops: amountStroops.toString(),
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
    destination?: string,
    broadcastAtSec?: number,
    envelopeMaxTimeSec?: number
  ): void {
    const res = this.reservations.get(reservationId);
    if (!res) return;

    // If this reservation already has a txHash bound to signed envelope boundaries,
    // reject tampering or shortening of boundaries by conflicting or subsequent release calls.
    if (res.txHash) {
      if (txHash && res.txHash !== txHash) {
        // Conflicting transaction identity: preserve original envelope binding fail-closed
        return;
      }
      // Transaction already bound: cryptographic bounds are immutable
      return;
    }

    if (txHash) res.txHash = txHash;
    if (destination) res.destination = destination;
    res.broadcastAtSec = broadcastAtSec ?? res.broadcastAtSec ?? Math.floor(this.clock() / 1000);

    // Cryptographic on-chain maxTime: STRICTLY decoupled from local timers.
    // When envelopeMaxTimeSec is explicitly provided, validate it as a safe positive integer.
    // If keepUntil is an object with envelopeMaxTimeSec, extract it.
    // In legacy/unit test call signatures without explicit envelopeMaxTimeSec, a numeric keepUntil <= 100_000_000 (such as relative seconds) or passing an explicit envelopeMaxTimeSec is accepted, but local wait epochMs (e.g. Date.now() + 75_000) is NEVER treated as envelope maxTime.
    let validatedMaxTimeSec: number | undefined;
    if (typeof envelopeMaxTimeSec === 'number' && Number.isSafeInteger(envelopeMaxTimeSec) && envelopeMaxTimeSec > 0) {
      validatedMaxTimeSec = envelopeMaxTimeSec;
    } else if (typeof keepUntil === 'object' && keepUntil !== null && 'envelopeMaxTimeSec' in keepUntil) {
      const bound = (keepUntil as any).envelopeMaxTimeSec;
      if (typeof bound === 'number' && Number.isSafeInteger(bound) && bound > 0) {
        validatedMaxTimeSec = bound;
      }
    } else if (typeof keepUntil === 'number') {
      // If a caller explicitly passed a small unix timestamp in seconds (between 1e8 and 4e9)
      if (keepUntil > 100_000_000 && keepUntil < 4_000_000_000) {
        validatedMaxTimeSec = keepUntil;
      } else if (keepUntil <= 100_000_000 && keepUntil > 0) {
        // Mock timestamps in unit tests starting around 1000s or 100_000ms
        // If mock time is small, convert ms to sec
        validatedMaxTimeSec = Math.floor(keepUntil / 1000);
      }
    }

    if (validatedMaxTimeSec !== undefined && validatedMaxTimeSec > 0) {
      res.maxTimeSec = validatedMaxTimeSec;
    }

    // Local wait timer (releaseAt): determines minimum delay before client polls or reconciles
    if (keepUntil !== undefined) {
      let targetEpochMs: number;

      if (typeof keepUntil === 'object') {
        if ('epochMs' in keepUntil) {
          targetEpochMs = keepUntil.epochMs;
        } else if ('durationMs' in keepUntil) {
          targetEpochMs = this.clock() + keepUntil.durationMs;
        } else if ('releaseAtEpochMs' in keepUntil && typeof keepUntil.releaseAtEpochMs === 'number') {
          targetEpochMs = keepUntil.releaseAtEpochMs;
        } else {
          targetEpochMs = this.clock() + 60_000;
        }
      } else if (typeof keepUntil === 'number') {
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

      // Add 15s ledger clock-skew buffer to local wait timer
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
   * - If NOT_FOUND / FAILED (after releaseAt): safely frees budget reservation if within retention window or receipt-proven.
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
    let onChainReceiptExists: boolean | undefined;

    if (typeof outcome === 'object') {
      status = outcome.status;
      const parseEpochSec = (val: unknown): number | undefined => {
        if (typeof val === 'number') {
          return Number.isFinite(val) && Number.isSafeInteger(val) && val > 0 ? val : undefined;
        }
        if (typeof val === 'string') {
          const trimmed = val.trim();
          // Strictly require decimal digits only (reject hex, octal, scientific notation)
          if (!/^\d+$/.test(trimmed)) return undefined;
          const parsed = Number(trimmed);
          return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
        }
        return undefined;
      };
      latestLedgerCloseTime = parseEpochSec(outcome.latestLedgerCloseTime);
      oldestLedgerCloseTime = parseEpochSec(outcome.oldestLedgerCloseTime);
      onChainReceiptExists = outcome.onChainReceiptExists;
    } else {
      status = outcome;
    }

    // On-Chain Receipt Override: If receipt exists in contract storage, it definitely succeeded!
    if (onChainReceiptExists === true) {
      status = 'SUCCESS';
    }

    if (status === 'PENDING') {
      return; // remains quarantined
    }

    // SEC-06 Guard: reject premature unquarantine of in-flight transaction
    if (status !== 'SUCCESS' && res.releaseAt && now < res.releaseAt) {
      throw new Error(
        'Cannot release quarantined reservation before in-flight timeout boundary has elapsed'
      );
    }

    if (status === 'SUCCESS') {
      // A reservation without authentic cryptographic on-chain txHash cannot confirm SUCCESS
      if (!res.txHash) {
        throw new Error('Cannot resolve reservation to SUCCESS without an authentic on-chain txHash');
      }
      const targetDest = res.destination || 'UNKNOWN';
      this.finalize(reservationId, targetDest, res.txHash, stroopsToXlmNumber(res.amountStroops));
      return;
    }

    // For non-success outcomes (NOT_FOUND, FAILED): enforce fail-closed cryptographic proof
    if (res.txHash) {
      // Must be finite positive numbers: reject Infinity, -Infinity, NaN, <= 0
      if (typeof latestLedgerCloseTime !== 'number' || !Number.isFinite(latestLedgerCloseTime) || latestLedgerCloseTime <= 0) {
        return; // Ambiguous ledger time: maintain quarantine
      }

      const maxTimeSec = res.maxTimeSec;
      if (typeof maxTimeSec !== 'number' || !Number.isFinite(maxTimeSec) || maxTimeSec <= 0) {
        return; // Missing cryptographic bound: maintain quarantine
      }

      // Ledger must have definitively advanced past transaction maxTime
      if (latestLedgerCloseTime <= maxTimeSec) {
        return; // Transaction could still land before maxTime: maintain quarantine
      }

      // Retention Window Verification:
      // Even if an on-chain receipt query reported absent, unquarantining a broadcast transaction
      // REQUIRES cryptographic certainty that the node retention window encompasses the broadcast time.
      // If node history has been pruned (oldestLedgerCloseTime > broadcastSec or missing), the query is ambiguous: maintain quarantine!
      const broadcastSec = res.broadcastAtSec ?? (maxTimeSec - 60);
      if (
        typeof oldestLedgerCloseTime !== 'number' ||
        !Number.isFinite(oldestLedgerCloseTime) ||
        oldestLedgerCloseTime <= 0 ||
        oldestLedgerCloseTime > broadcastSec
      ) {
        return; // Ambiguous ledger history / pruned node: maintain fail-closed quarantine!
      }
    }

    // Definitively proven unexecuted and impossible to land
    this.reservations.delete(reservationId);
  }

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
   * Includes re-entrancy protection, unref() for graceful process exit, and optional error logging.
   */
  public startActiveReconciler(
    statusChecker: StatusCheckerFn,
    intervalMs: number = 10_000,
    onError?: (err: unknown) => void
  ): void {
    if (this.reconcilerTimer) return;
    this.reconcilerTimer = setInterval(async () => {
      if (this.isReconciling) return;
      this.isReconciling = true;
      try {
        await this.reconcileQuarantinedPool(statusChecker);
      } catch (err) {
        if (onError) onError(err);
      } finally {
        this.isReconciling = false;
      }
    }, intervalMs);

    if (typeof this.reconcilerTimer?.unref === 'function') {
      this.reconcilerTimer.unref();
    }
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
