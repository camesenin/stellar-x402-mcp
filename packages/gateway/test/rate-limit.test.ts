import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import {
  TokenBucketRateLimiter,
  createTokenBucketRateLimitMiddleware,
} from '../src/middleware/rate-limit.js';

function createMockReqRes(headers: Record<string, string> = {}, ip = '10.0.0.1') {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }

  const req = {
    ip,
    socket: { remoteAddress: ip },
    header: (name: string) => normalized[name.toLowerCase()],
  } as unknown as Request;

  const responseHeaders: Record<string, string> = {};
  let statusCode = 200;
  let jsonBody: unknown;

  const res = {
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      jsonBody = payload;
      return res;
    },
  } as unknown as Response;

  return {
    req,
    res,
    responseHeaders,
    getStatusCode: () => statusCode,
    getJsonBody: () => jsonBody,
  };
}

describe('TokenBucketRateLimiter & Middleware', () => {
  it('enforces token capacity, refills deterministically, and emits X-RateLimit-* and RFC 7231 Retry-After headers', () => {
    let now = 1_700_000_000_000;
    const middleware = createTokenBucketRateLimitMiddleware({
      capacity: 2,
      refillRatePerSecond: 0.5, // 1 token every 2 seconds
      clock: () => now,
    });

    // Request 1: allowed (remaining 1)
    const call1 = createMockReqRes();
    const next1 = vi.fn();
    middleware(call1.req, call1.res, next1);
    expect(next1).toHaveBeenCalledOnce();
    expect(call1.responseHeaders['X-RateLimit-Limit']).toBe('2');
    expect(call1.responseHeaders['X-RateLimit-Remaining']).toBe('1');

    // Request 2: allowed (remaining 0)
    const call2 = createMockReqRes();
    const next2 = vi.fn();
    middleware(call2.req, call2.res, next2);
    expect(next2).toHaveBeenCalledOnce();
    expect(call2.responseHeaders['X-RateLimit-Remaining']).toBe('0');

    // Request 3: rejected with 429 and Retry-After: 2
    const call3 = createMockReqRes();
    const next3 = vi.fn();
    middleware(call3.req, call3.res, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(call3.getStatusCode()).toBe(429);
    expect(call3.responseHeaders['Retry-After']).toBe('2');
    expect(call3.responseHeaders['X-RateLimit-Remaining']).toBe('0');

    // Advance clock by 2000ms -> 1 token refilled
    now += 2_000;
    const call4 = createMockReqRes();
    const next4 = vi.fn();
    middleware(call4.req, call4.res, next4);
    expect(next4).toHaveBeenCalledOnce();
    expect(call4.responseHeaders['X-RateLimit-Remaining']).toBe('0');
  });

  it('partitions rate limit buckets per StrKey identity when provided', () => {
    const accountA = Keypair.random().publicKey();
    const accountB = Keypair.random().publicKey();

    const middleware = createTokenBucketRateLimitMiddleware({
      capacity: 1,
      refillRatePerSecond: 0.1,
    });

    const reqA1 = createMockReqRes({ 'X-Stellar-Account': accountA }, '10.0.0.1');
    const nextA1 = vi.fn();
    middleware(reqA1.req, reqA1.res, nextA1);
    expect(nextA1).toHaveBeenCalledOnce();

    // Second call from Account A is throttled
    const reqA2 = createMockReqRes({ 'X-Stellar-Account': accountA }, '10.0.0.1');
    const nextA2 = vi.fn();
    middleware(reqA2.req, reqA2.res, nextA2);
    expect(reqA2.getStatusCode()).toBe(429);

    // Call from Account B on the same IP has its own bucket and succeeds
    const reqB1 = createMockReqRes({ 'X-Stellar-Account': accountB }, '10.0.0.1');
    const nextB1 = vi.fn();
    middleware(reqB1.req, reqB1.res, nextB1);
    expect(nextB1).toHaveBeenCalledOnce();
  });

  it('cleans up idle buckets after expiration window', () => {
    let now = 10_000;
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillRatePerSecond: 1,
      clock: () => now,
    });

    expect(limiter.consume('ip:1.2.3.4').allowed).toBe(true);
    expect(limiter.consume('ip:1.2.3.4').allowed).toBe(false);

    now += 600_000;
    limiter.cleanup(300_000);
    expect(limiter.consume('ip:1.2.3.4').allowed).toBe(true);
  });
});
