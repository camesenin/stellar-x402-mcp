import { describe, it, expect, vi } from 'vitest';
import { Response } from 'express';
import { createX402Middleware, X402Request } from '../src/middleware.js';
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
});
