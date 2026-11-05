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

  it('rejects verification if challenge was issued for a different resource/route (resource substitution defense)', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    // Challenge created specifically for cheap route /api/cheap
    const challenge = store.createChallenge(dummyDest, '0.001', 'XLM', '/api/cheap');

    const middleware = createX402Middleware(
      {
        destinationPublicKey: dummyDest,
        defaultFeeXlm: '10.0', // expensive endpoint requires 10 XLM
      },
      store,
      verifier
    );

    // Attacker presents the cheap challenge to the expensive endpoint /api/expensive
    const req = {
      header: vi.fn((name: string) => {
        if (name === 'X-Stellar-TxHash') return 'dummy_tx';
        if (name === 'X-Challenge-Id') return challenge.challengeId;
        return undefined;
      }),
      query: {},
      originalUrl: '/api/expensive',
      path: '/api/expensive',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: vi.fn((code: number) => { statusCode = code; return res; }),
      setHeader: vi.fn(),
      json: vi.fn((b: any) => { jsonBody = b; return res; }),
    } as unknown as Response;

    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusCode).toBe(403);
    expect(jsonBody.error).toContain('Challenge Resource Mismatch');
    store.close();
  });

  it('returns HTTP 503 with Retry-After when verifier encounters transient simulation error, leaving tx unconsumed', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    const challenge = store.createChallenge(dummyDest, '0.05', 'XLM', '/api/resource');

    const dummyTx = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

    // Mock verifier returning retriable 503
    vi.spyOn(verifier, 'verifyPayment').mockResolvedValue({
      valid: false,
      retriable: true,
      statusCode: 503,
      reason: 'Temporary Soroban RPC simulation failure while deriving canonical challenge hash',
      txHash: dummyTx,
    });

    const middleware = createX402Middleware(
      {
        destinationPublicKey: dummyDest,
        defaultFeeXlm: '0.05',
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
      originalUrl: '/api/resource',
      path: '/api/resource',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    const headers: Record<string, string> = {};
    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: vi.fn((code: number) => { statusCode = code; return res; }),
      setHeader: vi.fn((k: string, v: string) => { headers[k] = v; return res; }),
      json: vi.fn((b: any) => { jsonBody = b; return res; }),
    } as unknown as Response;

    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusCode).toBe(503);
    expect(headers['Retry-After']).toBe('2');
    expect(jsonBody.retriable).toBe(true);

    // Crucial check: txHash must NOT have been consumed in SQLite store!
    expect(store.isTxRedeemed(dummyTx)).toBe(false);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);
    store.close();
  });

  it('e2e middleware: Horizon HTTP 520 / 5xx returns HTTP 520/503 with Retry-After, preserving state for retry and preventing replay afterwards', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier('https://horizon-testnet.stellar.org', 'https://soroban-testnet.stellar.org', 'testnet');
    const challenge = store.createChallenge(dummyDest, '0.05', 'XLM', '/api/resource');
    const dummyTx = '22334455667788990011aabbccddeeff22334455667788990011aabbccddeeff';

    // Injected Horizon 520 error into Horizon SDK call
    const horizon520 = new Error('Request failed with status code 520');
    (horizon520 as any).response = { status: 520 };
    vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => { throw horizon520; },
      }),
    } as any);

    const middleware = createX402Middleware(
      { destinationPublicKey: dummyDest, defaultFeeXlm: '0.05' },
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
      originalUrl: '/api/resource',
      path: '/api/resource',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    const headers: Record<string, string> = {};
    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: vi.fn((code: number) => { statusCode = code; return res; }),
      setHeader: vi.fn((k: string, v: string) => { headers[k] = v; return res; }),
      json: vi.fn((b: any) => { jsonBody = b; return res; }),
    } as unknown as Response;

    const next = vi.fn();
    // Step 1: Request encounters Horizon 520 transient failure
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // Must return 520 (or 503) instead of 402!
    expect([503, 520]).toContain(statusCode);
    expect(headers['Retry-After']).toBe('2');
    expect(jsonBody.retriable).toBe(true);
    expect(jsonBody.details).toContain('Stellar Horizon transient infrastructure failure');
    // Challenge and tx must remain unconsumed in SQLite store
    expect(store.isTxRedeemed(dummyTx)).toBe(false);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);

    // Step 2: Retry with successful Horizon response (same proof)
    vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => ({
          successful: true,
          memo: challenge.memo,
          ledger_attr: 50010,
          operations: async () => ({
            records: [
              {
                type: 'payment',
                to: dummyDest,
                source_account: 'GAUTONOMOUS_AI_AGENT_KEYPAIR_111111111111111111111111111111',
                amount: '0.05',
                asset_type: 'native',
              },
            ],
            next: async () => ({ records: [] }),
          }),
        }),
      }),
    } as any);

    let nextCalled = false;
    const nextSuccess = vi.fn(() => { nextCalled = true; });
    await middleware(req, res, nextSuccess);

    expect(nextCalled).toBe(true);
    expect(headers['X-Payment-Settled']).toBe('true');
    expect(headers['X-Payment-TxHash']).toBe(dummyTx);
    expect(store.isTxRedeemed(dummyTx)).toBe(true);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(true);

    // Step 3: Subsequent replay of the exact same tx hash with a new challenge must be rejected with 402 replay attack prevented
    const freshChallenge = store.createChallenge(dummyDest, '0.05', 'XLM', '/api/resource');
    const reqReplay = {
      header: vi.fn((name: string) => {
        if (name === 'X-Stellar-TxHash') return dummyTx;
        if (name === 'X-Challenge-Id') return freshChallenge.challengeId;
        return undefined;
      }),
      query: {},
      originalUrl: '/api/resource',
      path: '/api/resource',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    let replayStatusCode = 0;
    let replayJson: any = null;
    const resReplay = {
      status: vi.fn((code: number) => { replayStatusCode = code; return resReplay; }),
      setHeader: vi.fn(),
      json: vi.fn((b: any) => { replayJson = b; return resReplay; }),
    } as unknown as Response;

    const nextReplay = vi.fn();
    await middleware(reqReplay, resReplay, nextReplay);

    expect(nextReplay).not.toHaveBeenCalled();
    expect(replayStatusCode).toBe(402);
    expect(replayJson.details).toContain('replay attack prevented');
    store.close();
  });

  it('e2e middleware: Soroban RPC transient failure returns HTTP 503 with Retry-After, preserving state for retry, and strictly rejecting subsequent replay', async () => {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier('https://horizon-testnet.stellar.org', 'https://soroban-testnet.stellar.org', 'testnet');
    const targetVault = 'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO';
    const challenge = store.createChallenge(dummyDest, '0.05', 'XLM', '/api/soroban-resource', 'testnet', targetVault);
    const sorobanTxHash = '33445566778899001122aabbccddeeff33445566778899001122aabbccddeeff';

    // Step 1: Injected transient network error into fetchSorobanTxJsonRpc (RPC boundary failure)
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' }
    }));

    const middleware = createX402Middleware(
      { destinationPublicKey: dummyDest, defaultFeeXlm: '0.05' },
      store,
      verifier
    );

    const req = {
      header: vi.fn((name: string) => {
        if (name === 'X-Stellar-TxHash') return sorobanTxHash;
        if (name === 'X-Challenge-Id') return challenge.challengeId;
        return undefined;
      }),
      query: {},
      originalUrl: '/api/soroban-resource',
      path: '/api/soroban-resource',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    const headers: Record<string, string> = {};
    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: vi.fn((code: number) => { statusCode = code; return res; }),
      setHeader: vi.fn((k: string, v: string) => { headers[k] = v; return res; }),
      json: vi.fn((b: any) => { jsonBody = b; return res; }),
    } as unknown as Response;

    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusCode).toBe(503);
    expect(headers['Retry-After']).toBe('2');
    expect(jsonBody.retriable).toBe(true);
    expect(jsonBody.details).toContain('Soroban RPC getTransaction network timeout/transient failure');
    // State in SQLite store must remain completely unconsumed
    expect(store.isTxRedeemed(sorobanTxHash)).toBe(false);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);

    // Step 2: Retry with successful Soroban RPC response using real XDR and real receipt parser
    const { Keypair, TransactionBuilder, Networks, Contract, Address, nativeToScVal, xdr, Account } = await import('@stellar/stellar-sdk');
    const payerKp = Keypair.random();
    const expectedNonce = Buffer.from(challenge.challengeId, 'hex');

    // Build authentic Soroban TransactionEnvelope XDR with actual 'settle_payment' operation
    const dummyAccount = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
    const contract = new Contract(targetVault);
    const op = contract.call(
      'settle_payment',
      new Address(payerKp.publicKey()).toScVal(),
      new Address(dummyDest).toScVal(),
      new Address('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').toScVal(),
      nativeToScVal(500_000n, { type: 'i128' }),
      xdr.ScVal.scvBytes(expectedNonce)
    );
    const realEnvelope = new TransactionBuilder(dummyAccount, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const realEnvelopeXdr = realEnvelope.toXDR();

    // Mock fetchSorobanTxJsonRpc returning SUCCESS with authentic envelopeXdr
    vi.spyOn(verifier, 'fetchSorobanTxJsonRpc').mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: realEnvelopeXdr,
      ledger: 50020,
    });

    // Mock simulateTransaction for canonical on-chain hash simulation
    vi.spyOn((verifier as any).sorobanServer, 'simulateTransaction').mockResolvedValueOnce({
      result: {
        retval: {
          bytes: () => expectedNonce,
        },
      },
    });

    // Mock getContractData returning real LedgerEntryData with exact Rust PaymentReceipt ScVal map:
    // Rust struct PaymentReceipt {
    //   payer: Address,
    //   recipient: Address,
    //   token: Address,
    //   amount: i128,
    //   timestamp: u64,
    //   challenge_hash: BytesN<32>,
    // }
    const rustPaymentReceiptScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('amount'),
        val: nativeToScVal(500_000n, { type: 'i128' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('challenge_hash'),
        val: xdr.ScVal.scvBytes(expectedNonce),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('payer'),
        val: new Address(payerKp.publicKey()).toScVal(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('recipient'),
        val: new Address(dummyDest).toScVal(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('timestamp'),
        val: nativeToScVal(12345678n, { type: 'u64' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('token'),
        val: new Address('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').toScVal(),
      }),
    ]);

    // Encode into authentic LedgerEntryData and deserialize via xdr.LedgerEntryData.fromXDR
    const contractDataEntry = new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(targetVault).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Receipt'),
        xdr.ScVal.scvBytes(expectedNonce),
      ]),
      durability: xdr.ContractDataDurability.persistent(),
      val: rustPaymentReceiptScVal,
    });
    const ledgerEntryData = xdr.LedgerEntryData.contractData(contractDataEntry);
    const serializedLedgerEntry = ledgerEntryData.toXDR();
    const authenticDecodedLedgerEntry = xdr.LedgerEntryData.fromXDR(serializedLedgerEntry);

    vi.spyOn((verifier as any).sorobanServer, 'getContractData').mockResolvedValueOnce({
      val: authenticDecodedLedgerEntry,
    } as any);

    let nextCalled = false;
    const nextSuccess = vi.fn(() => { nextCalled = true; });
    await middleware(req, res, nextSuccess);

    expect(nextCalled).toBe(true);
    expect(headers['X-Payment-Settled']).toBe('true');
    expect(headers['X-Payment-TxHash']).toBe(sorobanTxHash);
    expect(store.isTxRedeemed(sorobanTxHash)).toBe(true);
    expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(true);

    // Step 3: Subsequent replay of the exact same Soroban tx against a fresh challenge is rejected with HTTP 402 replay attack prevented
    const freshChallenge = store.createChallenge(dummyDest, '0.05', 'XLM', '/api/soroban-resource', 'testnet', targetVault);
    const reqReplay = {
      header: vi.fn((name: string) => {
        if (name === 'X-Stellar-TxHash') return sorobanTxHash;
        if (name === 'X-Challenge-Id') return freshChallenge.challengeId;
        return undefined;
      }),
      query: {},
      originalUrl: '/api/soroban-resource',
      path: '/api/soroban-resource',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as X402Request;

    let replayStatusCode = 0;
    let replayJson: any = null;
    const resReplay = {
      status: vi.fn((code: number) => { replayStatusCode = code; return resReplay; }),
      setHeader: vi.fn(),
      json: vi.fn((b: any) => { replayJson = b; return resReplay; }),
    } as unknown as Response;

    const nextReplay = vi.fn();
    await middleware(reqReplay, resReplay, nextReplay);

    expect(nextReplay).not.toHaveBeenCalled();
    expect(replayStatusCode).toBe(402);
    expect(replayJson.details).toContain('replay attack prevented');
    store.close();
  });
});
