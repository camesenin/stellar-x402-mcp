export class BudgetManager {
  private totalSpentXlm: number = 0;
  private receipts: Array<{
    amount: number;
    destination: string;
    timestamp: number;
    txHash: string;
  }> = [];

  constructor(
    private maxPerCallXlm: number = 1.0,
    private totalCeilingXlm: number = 10.0
  ) {}

  public canAfford(amountXlm: number): { allowed: boolean; reason?: string } {
    if (amountXlm > this.maxPerCallXlm) {
      return {
        allowed: false,
        reason: `Requested payment ${amountXlm} XLM exceeds per-call limit of ${this.maxPerCallXlm} XLM`,
      };
    }

    if (this.totalSpentXlm + amountXlm > this.totalCeilingXlm) {
      return {
        allowed: false,
        reason: `Cumulative spending ${(this.totalSpentXlm + amountXlm).toFixed(4)} XLM would exceed total budget limit of ${this.totalCeilingXlm} XLM`,
      };
    }

    return { allowed: true };
  }

  public recordPayment(amountXlm: number, destination: string, txHash: string): void {
    this.totalSpentXlm += amountXlm;
    this.receipts.push({
      amount: amountXlm,
      destination,
      timestamp: Date.now(),
      txHash,
    });
  }

  public getSpentTotal(): number {
    return this.totalSpentXlm;
  }

  public getReceipts() {
    return [...this.receipts];
  }
}
