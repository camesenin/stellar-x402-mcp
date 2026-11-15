import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { PrometheusMetricsCollector } from '../src/metrics/prometheus.js';

describe('PrometheusMetricsCollector (/metrics exporter)', () => {
  it('tracks x402_requests_total, x402_settlement_duration_seconds, and x402_dispatch_failures_total in Prometheus text format', () => {
    const collector = new PrometheusMetricsCollector([0.1, 0.5, 1, 5]);

    collector.incRequests({ method: 'GET', route: '/api/protected-intel', status: '402' });
    collector.incRequests({ method: 'GET', route: '/api/protected-intel', status: '200' }, 2);

    collector.observeSettlementDuration(
      { network: 'testnet', asset: 'XLM', outcome: 'confirmed' },
      0.08
    );
    collector.observeSettlementDuration(
      { network: 'testnet', asset: 'XLM', outcome: 'confirmed' },
      0.42
    );

    collector.incDispatchFailures({ reason: 'rpc_timeout', network: 'testnet' });

    const output = collector.render();

    expect(output).toContain('# TYPE x402_requests_total counter');
    expect(output).toContain(
      'x402_requests_total{method="GET",route="/api/protected-intel",status="402"} 1'
    );
    expect(output).toContain(
      'x402_requests_total{method="GET",route="/api/protected-intel",status="200"} 2'
    );

    expect(output).toContain('# TYPE x402_settlement_duration_seconds histogram');
    expect(output).toContain(
      'x402_settlement_duration_seconds_bucket{network="testnet",asset="XLM",outcome="confirmed",le="0.1"} 1'
    );
    expect(output).toContain(
      'x402_settlement_duration_seconds_bucket{network="testnet",asset="XLM",outcome="confirmed",le="0.5"} 2'
    );
    expect(output).toContain(
      'x402_settlement_duration_seconds_bucket{network="testnet",asset="XLM",outcome="confirmed",le="+Inf"} 2'
    );
    expect(output).toContain(
      'x402_settlement_duration_seconds_count{network="testnet",asset="XLM",outcome="confirmed"} 2'
    );

    expect(output).toContain('# TYPE x402_dispatch_failures_total counter');
    expect(output).toContain(
      'x402_dispatch_failures_total{reason="rpc_timeout",network="testnet"} 1'
    );
  });

  it('serves /metrics endpoint with Prometheus text/plain 0.0.4 Content-Type', () => {
    const collector = new PrometheusMetricsCollector();
    collector.incRequests({ method: 'POST', route: '/mcp', status: '200' });

    const handler = collector.createMetricsHandler();
    const headers: Record<string, string> = {};
    let statusCode = 0;
    let body = '';

    const res = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      status: (c: number) => {
        statusCode = c;
        return res;
      },
      send: (payload: string) => {
        body = payload;
        return res;
      },
    } as unknown as Response;

    handler({} as Request, res);

    expect(statusCode).toBe(200);
    expect(headers['Content-Type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(body).toContain('x402_requests_total{method="POST",route="/mcp",status="200"} 1');
  });
});
