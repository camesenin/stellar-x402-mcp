import { describe, it, expect, vi } from 'vitest';
import { Response } from 'express';
import { createX402Middleware, getClientIp, X402Request } from '../src/middleware.js';
import { ChallengeStore } from '../src/challenge-store.js';
import { StellarPaymentVerifier } from '../src/verifier.js';

describe('createX402Middleware with SQLite', () => {
  const dummyDest = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  it('returns 402 with challenge headers when no payment is provided', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    const middleware = createX402Middleware(
      {
        destinationPublicKey: dummyDest,
        defaultFeeXlm: '0.02',
      },
      store,
      verifier
    );

    const req = {
      header: vi.fn().mockReturnValue(undefined),
      query: {},
      originalUrl: '/api/resource',
      path: '/api/resource',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    const headers: Record<string, string> = {};
    let statusCode = 200;
    let jsonBody: unknown = null;

    const res = {
      status: vi.fn((code: number) => {
        statusCode = code;
        return res;
      }),
      setHeader: vi.fn((key: string, value: string) => {
        headers[key] = value;
        return res;
      }),
      json: vi.fn((body: unknown) => {
        jsonBody = body;
        return res;
      }),
    } as unknown as Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
    expect(headers['X-Payment-Address']).toBe(dummyDest);
    expect(headers['X-Payment-Amount']).toBe('0.02');
    expect(headers['X-Payment-Asset']).toBe('XLM');
    expect(headers['X-Challenge-Id']).toBeDefined();
    expect(headers['WWW-Authenticate']).toContain('StellarX402');
    expect((jsonBody as Record<string, unknown>).status).toBe(402);

    store.close();
  });

  it('verifies valid payment and allows request to continue to next()', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    const challenge = store.createChallenge(dummyDest, '0.01', 'XLM', '/api');

    const dummyTx = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

    // Mock verifyPayment
    vi.spyOn(verifier, 'verifyPayment').mockResolvedValue({
      valid: true,
      payer: 'GCPAYER1234567890ABCDEF1234567890ABCDEF',
      amount: '0.01',
      asset: 'XLM',
      ledger: 500123,
      txHash: dummyTx,
    });

    const middleware = createX402Middleware(
      {
        destinationPublicKey: dummyDest,
      },
      store,
      verifier
    );

    const req = {
      header: vi.fn((name: string) => {
        if (name === 'X-Stellar-TxHash') return dummyTx;
        if (name === 'X-Challenge-Id') return challenge.challengeId;
        return undefined;
      }),
      query: {},
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    const setHeaders: Record<string, string> = {};
    const res = {
      setHeader: vi.fn((key: string, value: string) => {
        setHeaders[key] = value;
      }),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.stellarPayment?.valid).toBe(true);
    expect(setHeaders['X-Payment-Settled']).toBe('true');
    expect(setHeaders['X-Payment-TxHash']).toBe(dummyTx);

    store.close();
  });

  it('safely handles IP spoofing and respects deterministic injectable clock in rate limiter', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    let mockTime = 1_000_000;

    const middleware = createX402Middleware(
      {
        destinationPublicKey: dummyDest,
        trustProxy: false, // Explicitly untrusted proxy: X-Forwarded-For must be ignored!
      },
      store,
      verifier,
      undefined,
      () => mockTime
    );

    // Make 60 requests from socket IP 192.168.1.50 with a fake X-Forwarded-For
    for (let i = 0; i < 60; i++) {
      const req = {
        header: vi.fn((h: string) => (h.toLowerCase() === 'x-forwarded-for' ? `10.0.0.${i}` : undefined)),
        query: {},
        originalUrl: '/test',
        ip: undefined,
        socket: { remoteAddress: '192.168.1.50' },
      } as unknown as X402Request;

      let statusCode = 0;
      const res = {
        status: vi.fn((code: number) => { statusCode = code; return res; }),
        setHeader: vi.fn(),
        json: vi.fn(),
      } as unknown as Response;

      await middleware(req, res, vi.fn());
      expect(statusCode).toBe(402);
    }

    // 61st request from same socket IP should be rate limited, despite different fake X-Forwarded-For
    const req61 = {
      header: vi.fn((h: string) => (h.toLowerCase() === 'x-forwarded-for' ? '1.2.3.4' : undefined)),
      query: {},
      originalUrl: '/test',
      ip: undefined,
      socket: { remoteAddress: '192.168.1.50' },
    } as unknown as X402Request;

    let code61 = 0;
    const res61 = {
      status: vi.fn((code: number) => { code61 = code; return res61; }),
      setHeader: vi.fn(),
      json: vi.fn(),
    } as unknown as Response;

    await middleware(req61, res61, vi.fn());
    expect(code61).toBe(429); // Correctly blocked!

    // Advance clock past the 60-second window
    mockTime += 60_001;

    // Now request is allowed again
    let code62 = 0;
    const res62 = {
      status: vi.fn((code: number) => { code62 = code; return res62; }),
      setHeader: vi.fn(),
      json: vi.fn(),
    } as unknown as Response;

    await middleware(req61, res62, vi.fn());
    expect(code62).toBe(402);

    store.close();
  });

  it('enforces requester authentication when requireRequesterAuth is enabled', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    const challenge = store.createChallenge(dummyDest, '0.01', 'XLM', '/api');
    const dummyTx = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const middleware = createX402Middleware(
      {
        destinationPublicKey: dummyDest,
        requireRequesterAuth: true,
      },
      store,
      verifier
    );

    // Request with valid tx and challengeId but MISSING X-Payer-Signature
    const req = {
      header: vi.fn((name: string) => {
        if (name === 'X-Stellar-TxHash') return dummyTx;
        if (name === 'X-Challenge-Id') return challenge.challengeId;
        return undefined;
      }),
      query: {},
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: vi.fn((code: number) => { statusCode = code; return res; }),
      setHeader: vi.fn(),
      json: vi.fn((b) => { jsonBody = b; }),
    } as unknown as Response;

    const next = vi.fn();
    await middleware(req, res, next);

    expect(statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(jsonBody.error).toBe('Requester Signature Required');

    store.close();
  });

  it('securely extracts client IP using hop-count traversal and proxy allowlist', () => {
    // Untrusted proxy -> strictly socket IP
    const req1 = {
      header: (h: string) => (h.toLowerCase() === 'x-forwarded-for' ? '203.0.113.195, 70.41.3.18' : undefined),
      ip: undefined,
      socket: { remoteAddress: '10.0.0.1' },
    } as any;
    expect(getClientIp(req1, false)).toBe('10.0.0.1');

    // Hop count = 1: selects 1 hop from the right (client behind 1 reverse proxy)
    expect(getClientIp(req1, 1)).toBe('70.41.3.18');

    // Hop count = 2: selects 2 hops from the right
    expect(getClientIp(req1, 2)).toBe('203.0.113.195');

    // Proxy allowlist: socket 10.0.0.1 is trusted; returns rightmost untrusted IP
    const req2 = {
      header: (h: string) => (h.toLowerCase() === 'x-forwarded-for' ? '198.51.100.22, 10.0.0.2' : undefined),
      ip: undefined,
      socket: { remoteAddress: '10.0.0.1' },
    } as any;
    expect(getClientIp(req2, ['10.0.0.1', '10.0.0.2'])).toBe('198.51.100.22');

    // Socket is untrusted -> ignores XFF even if allowlist configured
    const req3 = {
      header: (h: string) => (h.toLowerCase() === 'x-forwarded-for' ? '1.2.3.4' : undefined),
      ip: undefined,
      socket: { remoteAddress: '192.168.1.99' },
    } as any;
    expect(getClientIp(req3, ['10.0.0.1'])).toBe('192.168.1.99');
  });
});
