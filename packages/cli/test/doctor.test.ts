import { describe, it, expect } from 'vitest';
import { runNetworkDoctor } from '../src/commands/doctor.js';

describe('x402-stellar doctor subcommand', () => {
  it('reports healthy and synced status when Soroban RPC and Horizon respond cleanly', async () => {
    let now = 1_000;
    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      now += 25;
      const url = String(input);
      if (url.includes('soroban')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
        if (body.method === 'getHealth') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { status: 'healthy', latestLedger: 543210 },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { sequence: 543211, protocolVersion: 22 },
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          history_latest_ledger: 543210,
          current_protocol_version: 22,
        }),
        { status: 200 }
      );
    };

    const report = await runNetworkDoctor({
      network: 'testnet',
      fetchImpl: mockFetch as typeof fetch,
      clock: () => now,
    });

    expect(report.healthy).toBe(true);
    expect(report.synced).toBe(true);
    expect(report.sorobanRpc.reachable).toBe(true);
    expect(report.sorobanRpc.latestLedger).toBe(543211);
    expect(report.horizon.reachable).toBe(true);
    expect(report.horizon.latestLedger).toBe(543210);
    expect(report.ledgerSyncLag).toBe(1);
  });

  it('returns unhealthy when Soroban RPC or Horizon is unreachable', async () => {
    const failingFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('soroban')) {
        throw new Error('ECONNREFUSED');
      }
      return new Response(JSON.stringify({ history_latest_ledger: 100 }), { status: 200 });
    };

    const report = await runNetworkDoctor({
      network: 'testnet',
      fetchImpl: failingFetch as typeof fetch,
    });

    expect(report.healthy).toBe(false);
    expect(report.sorobanRpc.reachable).toBe(false);
    expect(report.sorobanRpc.error).toContain('ECONNREFUSED');
    expect(report.horizon.reachable).toBe(true);
  });

  it('detects excessive ledger sync drift between Soroban RPC and Horizon', async () => {
    const driftingFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('soroban')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
        if (body.method === 'getHealth') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sequence: 1000, protocolVersion: 22 } }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ history_latest_ledger: 950, current_protocol_version: 22 }),
        { status: 200 }
      );
    };

    const report = await runNetworkDoctor({
      network: 'public',
      fetchImpl: driftingFetch as typeof fetch,
    });

    expect(report.sorobanRpc.reachable).toBe(true);
    expect(report.horizon.reachable).toBe(true);
    expect(report.ledgerSyncLag).toBe(50);
    expect(report.synced).toBe(false);
    expect(report.healthy).toBe(false);
  });
});
