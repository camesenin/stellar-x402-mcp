import crypto from 'node:crypto';

interface ActiveReservation {
  id: string;
  amountXlm: number;
  reservedAt: number;
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
    private reservationTtlMs: number = 120_000
  ) {}

  private pruneExpiredReservations(): void {
    const now = Date.now();
    for (const [id, res] of this.reservations.entries()) {
      if (now - res.reservedAt > this.reservationTtlMs) {
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
   * Release reservation if transaction was cancelled, failed or timed out
   */
  public release(reservationId: string): void {
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
