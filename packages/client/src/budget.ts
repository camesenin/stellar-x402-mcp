import crypto from 'node:crypto';

interface ActiveReservation {
  id: string;
  amountXlm: number;
  reservedAt: number;
  releaseAt?: number;
}

export class BudgetManager {
  private totalSettledXlm: number = 0;
  private reservations = new Map<string, ActiveReservation>();
  private receipts: Array<{
    amount: number;
    destination: string;
    timestamp: number;
    txHash: string;
  }> = [];

  constructor(
    private maxPerCallXlm: number = 1.0,
    private totalCeilingXlm: number = 10.0,
    private reservationTtlMs: number = 120_000,
    private clock: () => number = () => Date.now()
  ) {}

  private pruneExpiredReservations(): void {
    const now = this.clock();
    for (const [id, res] of this.reservations.entries()) {
      if (res.releaseAt) {
        if (now >= res.releaseAt) {
          this.reservations.delete(id);
        }
      } else if (now - res.reservedAt > this.reservationTtlMs) {
        this.reservations.delete(id);
      }
    }
  }

  public getPendingReservedXlm(): number {
    this.pruneExpiredReservations();
    let pending = 0;
    for (const res of this.reservations.values()) {
      pending += res.amountXlm;
    }
    return pending;
  }

  public canAfford(amountXlm: number): { allowed: boolean; reason?: string } {
    if (amountXlm <= 0) {
      return { allowed: false, reason: 'Payment amount must be greater than zero' };
    }

    if (amountXlm > this.maxPerCallXlm) {
      return {
        allowed: false,
        reason: `Requested payment ${amountXlm} XLM exceeds per-call limit of ${this.maxPerCallXlm} XLM`,
      };
    }

    const pendingReserved = this.getPendingReservedXlm();
    const projectedTotal = this.totalSettledXlm + pendingReserved + amountXlm;

    if (projectedTotal > this.totalCeilingXlm) {
      return {
        allowed: false,
        reason: `Projected cumulative spending ${projectedTotal.toFixed(4)} XLM (settled: ${this.totalSettledXlm.toFixed(4)}, reserved: ${pendingReserved.toFixed(4)}) would exceed total ceiling of ${this.totalCeilingXlm} XLM`,
      };
    }

    return { allowed: true };
  }

  /**
   * Concurrency-safe budget reservation.
   * Atomically locks amount from total ceiling while transaction is prepared and confirmed.
   */
  public reserve(amountXlm: number): string {
    const check = this.canAfford(amountXlm);
    if (!check.allowed) {
      throw new Error(`Budget reservation rejected: ${check.reason}`);
    }

    const reservationId = crypto.randomUUID();
    this.reservations.set(reservationId, {
      id: reservationId,
      amountXlm,
      reservedAt: Date.now(),
    });

    return reservationId;
  }

  /**
   * Finalize reservation upon successful on-chain confirmation
   */
  public finalize(reservationId: string, destination: string, txHash: string): void {
    const res = this.reservations.get(reservationId);
    const amount = res ? res.amountXlm : 0;
    if (res) {
      this.reservations.delete(reservationId);
    }

    this.totalSettledXlm += amount;
    this.receipts.push({
      amount,
      destination,
      timestamp: Date.now(),
      txHash,
    });
  }

  /**
   * Release reservation if transaction was cancelled, failed or timed out.
   * If keepUntilTime is provided (e.g. transaction maxTime / maxLedger timeout bound),
   * the reservation is quarantined in pending status until that timestamp has passed
   * to strictly prevent double-spending / overdraft from in-flight transactions landing later.
   */
  public release(reservationId: string, keepUntilTime?: number): void {
    const res = this.reservations.get(reservationId);
    if (!res) return;

    if (keepUntilTime !== undefined) {
      // If provided as unix epoch seconds (e.g. 1.7B+), normalize to milliseconds
      const keepMs = keepUntilTime > 1_000_000_000 && keepUntilTime < 10_000_000_000
        ? keepUntilTime * 1000
        : keepUntilTime;
      // If maxTime was 0 or unassigned, default to 60s quarantine; otherwise apply timestamp + 15s clock skew margin
      const effectiveKeepUntil = keepMs > 0 ? keepMs + 15_000 : this.clock() + 60_000;
      if (effectiveKeepUntil > this.clock()) {
        res.releaseAt = effectiveKeepUntil;
        return;
      }
    }
    this.reservations.delete(reservationId);
  }

  public recordPayment(amountXlm: number, destination: string, txHash: string): void {
    this.totalSettledXlm += amountXlm;
    this.receipts.push({
      amount: amountXlm,
      destination,
      timestamp: Date.now(),
      txHash,
    });
  }

  public getSpentTotal(): number {
    return this.totalSettledXlm;
  }

  public getReceipts() {
    return [...this.receipts];
  }
}
