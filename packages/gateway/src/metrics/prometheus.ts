import { Request, Response } from 'express';

export interface RequestMetricLabels {
  method: string;
  route: string;
  status: string;
}

export interface SettlementMetricLabels {
  network: string;
  asset: string;
  outcome: 'confirmed' | 'rejected' | 'error';
}

export interface DispatchFailureLabels {
  reason: string;
  network: string;
}

interface HistogramState {
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

const DEFAULT_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabelValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function serializeLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const formatted = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `{${formatted}}`;
}

export class PrometheusMetricsCollector {
  private readonly requestsTotal = new Map<string, { labels: RequestMetricLabels; value: number }>();
  private readonly dispatchFailuresTotal = new Map<
    string,
    { labels: DispatchFailureLabels; value: number }
  >();
  private readonly settlementDuration = new Map<
    string,
    { labels: SettlementMetricLabels; state: HistogramState }
  >();
  private readonly buckets: number[];

  constructor(buckets: number[] = DEFAULT_DURATION_BUCKETS) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  public incRequests(labels: RequestMetricLabels, count: number = 1): void {
    const key = serializeLabels(labels as unknown as Record<string, string>);
    const entry = this.requestsTotal.get(key);
    if (entry) {
      entry.value += count;
    } else {
      this.requestsTotal.set(key, { labels, value: count });
    }
  }

  public observeSettlementDuration(labels: SettlementMetricLabels, durationSeconds: number): void {
    const safeDuration = Math.max(0, durationSeconds);
    const key = serializeLabels(labels as unknown as Record<string, string>);
    let entry = this.settlementDuration.get(key);
    if (!entry) {
      const bucketMap = new Map<number, number>();
      for (const bound of this.buckets) {
        bucketMap.set(bound, 0);
      }
      entry = {
        labels,
        state: {
          buckets: bucketMap,
          sum: 0,
          count: 0,
        },
      };
      this.settlementDuration.set(key, entry);
    }

    entry.state.count += 1;
    entry.state.sum += safeDuration;
    for (const bound of this.buckets) {
      if (safeDuration <= bound) {
        entry.state.buckets.set(bound, (entry.state.buckets.get(bound) ?? 0) + 1);
      }
    }
  }

  public incDispatchFailures(labels: DispatchFailureLabels, count: number = 1): void {
    const key = serializeLabels(labels as unknown as Record<string, string>);
    const entry = this.dispatchFailuresTotal.get(key);
    if (entry) {
      entry.value += count;
    } else {
      this.dispatchFailuresTotal.set(key, { labels, value: count });
    }
  }

  public render(): string {
    const lines: string[] = [];

    lines.push('# HELP x402_requests_total Total number of HTTP/MCP requests processed by the x402 gateway.');
    lines.push('# TYPE x402_requests_total counter');
    for (const [labelSelector, entry] of this.requestsTotal.entries()) {
      lines.push(`x402_requests_total${labelSelector} ${entry.value}`);
    }

    lines.push(
      '# HELP x402_settlement_duration_seconds Histogram of Stellar payment verification and settlement durations in seconds.'
    );
    lines.push('# TYPE x402_settlement_duration_seconds histogram');
    for (const [, entry] of this.settlementDuration.entries()) {
      const baseLabels = entry.labels as unknown as Record<string, string>;
      for (const bound of this.buckets) {
        const bucketLabels = serializeLabels({ ...baseLabels, le: String(bound) });
        const count = entry.state.buckets.get(bound) ?? 0;
        lines.push(`x402_settlement_duration_seconds_bucket${bucketLabels} ${count}`);
      }
      const infLabels = serializeLabels({ ...baseLabels, le: '+Inf' });
      lines.push(`x402_settlement_duration_seconds_bucket${infLabels} ${entry.state.count}`);

      const metricLabels = serializeLabels(baseLabels);
      lines.push(`x402_settlement_duration_seconds_sum${metricLabels} ${entry.state.sum}`);
      lines.push(`x402_settlement_duration_seconds_count${metricLabels} ${entry.state.count}`);
    }

    lines.push(
      '# HELP x402_dispatch_failures_total Total number of payment verification or upstream RPC dispatch failures.'
    );
    lines.push('# TYPE x402_dispatch_failures_total counter');
    for (const [labelSelector, entry] of this.dispatchFailuresTotal.entries()) {
      lines.push(`x402_dispatch_failures_total${labelSelector} ${entry.value}`);
    }

    return `${lines.join('\n')}\n`;
  }

  public createMetricsHandler() {
    return (_req: Request, res: Response): void => {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.status(200).send(this.render());
    };
  }
}
