import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { xdr, Address, nativeToScVal, Keypair } from '@stellar/stellar-sdk';
import { StellarPaymentVerifier, amountToStroops, stroopsToDecimalString } from '../src/verifier.js';
import { ChallengeStore } from '../src/challenge-store.js';
import { X402Challenge } from '../src/types.js';

describe('StellarPaymentVerifier & amountToStroops', () => {
  let tempDbPath: string;
  let store: ChallengeStore;
  let verifier: StellarPaymentVerifier;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `x402_verifier_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`
    );
    store = new ChallengeStore(tempDbPath);
    verifier = new StellarPaymentVerifier(
      'https://horizon-testnet.stellar.org',
      'https://soroban-testnet.stellar.org',
      'testnet'
    );
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // Windows file locking tolerance
      }
    }
  });

  it('accurately converts human decimal amounts to integer stroops (7 decimals)', () => {
    expect(amountToStroops('1')).toBe(10_000_000n);
    expect(amountToStroops('0.05')).toBe(500_000n);
    expect(amountToStroops('0.0000001')).toBe(1n);
    expect(amountToStroops('1.5')).toBe(15_000_000n);
    expect(amountToStroops('10.2500000')).toBe(102_500_000n);
  });

  it('enforces rigorous decimal constraints on amountToStroops', () => {
    // Negative amounts must throw
    expect(() => amountToStroops('-1')).toThrow(/Amount must be positive/i);
    expect(() => amountToStroops('-0.05')).toThrow(/Amount must be positive/i);

    // Non-numeric strings must throw
    expect(() => amountToStroops('abc')).toThrow(/Expected valid numeric string/i);
    expect(() => amountToStroops('1.2.3')).toThrow(/Expected valid numeric string/i);

    // Excess precision (>7 decimal places) must throw
    expect(() => amountToStroops('0.12345678')).toThrow(/Excess decimal precision/i);

    // Zero or empty must throw
    expect(() => amountToStroops('0')).toThrow(/must be greater than zero stroops/i);
    expect(() => amountToStroops('')).toThrow(/Amount must be positive/i);
  });

  it('accurately converts integer stroops (bigint) to exact decimal string without precision loss', () => {
    expect(stroopsToDecimalString(10_000_000n)).toBe('1');
    expect(stroopsToDecimalString(500_000n)).toBe('0.05');
    expect(stroopsToDecimalString(1n)).toBe('0.0000001');
    expect(stroopsToDecimalString(15_000_000n)).toBe('1.5');
    expect(stroopsToDecimalString(102_500_000n)).toBe('10.25');

    // Numbers exceeding Number.MAX_SAFE_INTEGER (9007199254740991)
    const largeStroops = 9007199254740993n;
    expect(stroopsToDecimalString(largeStroops)).toBe('900719925.4740993');

    // Exact round-trip invariant
    expect(amountToStroops(stroopsToDecimalString(largeStroops))).toBe(largeStroops);
  });

  it('rejects verification if transaction hash has already been redeemed', async () => {
    const dummyTx = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const challenge: X402Challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );

    // First mark as redeemed
    store.markRedeemed(challenge.challengeId, dummyTx);

    // Attempt verify
    const result = await verifier.verifyPayment(dummyTx, challenge, store);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/already been redeemed/i);
  });

  it('correctly aggregates payment operations across multiple Horizon paginated pages', async () => {
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );

    const page1Records = [
      {
        type: 'payment',
        to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '0.02',
        asset_type: 'native',
      },
    ];

    const page2Records = [
      {
        type: 'payment',
        to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '0.03',
        asset_type: 'native',
      },
    ];

    const mockTx = {
      id: 'multipage_tx_hash',
      successful: true,
      source_account: 'GAUTONOMOUS_TEST_PAYER_123456789012345678901234567890',
      memo: challenge.memo,
      ledger_attr: 123456,
      operations: async () => ({
        records: page1Records,
        next: async () => ({
          records: page2Records,
          next: async () => ({ records: [] }),
        }),
      }),
    };

    vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => mockTx,
      }),
    } as any);

    const result = await verifier.verifyPayment('multipage_tx_hash', challenge, store);
    expect(result.valid).toBe(true);
    expect(result.amount).toBe('0.05');
  });

  it('rejects verification if challenge has already been settled', async () => {
    const tx1 = '1111111111111111111111111111111111111111111111111111111111111111';
    const tx2 = '2222222222222222222222222222222222222222222222222222222222222222';
    const challenge: X402Challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );

    store.markRedeemed(challenge.challengeId, tx1);

    // Another transaction attempting to settle the same challenge
    const result = await verifier.verifyPayment(tx2, challenge, store);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/already been settled/i);
  });

  it('rejects verification if contractId does not match pinnedVaultContractId', async () => {
    const pinnedVerifier = new StellarPaymentVerifier(
      'https://horizon-testnet.stellar.org',
      'https://soroban-testnet.stellar.org',
      'testnet',
      'CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA' // Pinned legitimate contract
    );

    const spoofedChallenge: X402Challenge = {
      challengeId: 'spoofed_challenge_123',
      destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: '0.05',
      asset: 'XLM',
      memo: 'spoofed_memo',
      network: 'testnet',
      contractId: 'CATTACKER_SPOOFED_CONTRACT_ID_11111111111111111111111111',
      resource: '/resource',
      expiresAt: Date.now() + 60_000,
    };

    const result = await pinnedVerifier.verifyPayment('any_tx_hash', spoofedChallenge, store);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Untrusted contract ID');
  });

  it('rejects smart contract accounts (C...) cleanly for direct ed25519 signature verification', async () => {
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );
    challenge.contractId = 'CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA';

    // Mock receipt where payer is a Soroban Contract (C...)
    vi.spyOn(verifier as any, 'fetchSorobanTxJsonRpc').mockResolvedValue({
      status: 'SUCCESS',
      envelopeXdr: 'AAAA', // non-empty
    });

    const crypto = await import('node:crypto');
    const expectedHash = Buffer.from(challenge.challengeId, 'hex');
    vi.spyOn(verifier, 'computeCanonicalChallengeHash').mockResolvedValue(expectedHash);

    vi.spyOn(xdr.TransactionEnvelope, 'fromXDR').mockReturnValue({
      value: () => ({
        tx: () => ({
          operations: () => [{
            body: () => ({
              switch: () => ({ name: 'invokeHostFunction' }),
              invokeHostFunctionOp: () => ({
                hostFunction: () => ({
                  switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
                  invokeContract: () => ({
                    contractAddress: () => Address.fromString('CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA').toScAddress(),
                    functionName: () => Buffer.from('settle_payment'),
                    args: () => [
                      new Address('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM').toScVal(),
                      new Address('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').toScVal(),
                      new Address('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').toScVal(),
                      nativeToScVal(500_000n, { type: 'i128' }),
                      xdr.ScVal.scvBytes(expectedHash),
                    ],
                  }),
                }),
              }),
            }),
          }],
        }),
      }),
    } as any);

    vi.spyOn(verifier as any, 'querySorobanContractReceipt').mockResolvedValue({
      payer: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', // Contract address
      recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      amount: 500_000n,
      timestamp: 1730000000,
    });

    const domainMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/resource:${challenge.challengeId}:dummy_tx:${challenge.expiresAt}`;
    const result = await verifier.verifyPayment('dummy_tx', challenge, store, {
      message: domainMessage,
      signatureBase64: 'AAAA',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Direct cryptographic signature verification requires standard ed25519 agent keypair');
  });

  it('rejects transaction if Soroban RPC status is FAILED even if parameters match', async () => {
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );
    challenge.contractId = 'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO';

    // Mock RPC returning FAILED transaction status
    vi.spyOn(verifier as any, 'fetchSorobanTxJsonRpc').mockResolvedValue({
      status: 'FAILED',
      envelopeXdr: 'AAAA',
    });

    const result = await verifier.verifyPayment('failed_tx_hash', challenge, store);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Soroban transaction status is 'FAILED'");
  });

  it('correctly handles and unpacks FeeBump transaction envelopes', async () => {
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );
    challenge.contractId = 'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO';

    vi.spyOn(verifier as any, 'fetchSorobanTxJsonRpc').mockResolvedValue({
      status: 'SUCCESS',
      envelopeXdr: 'DUMMY_FEE_BUMP_XDR',
    });

    const expectedHash = Buffer.from(challenge.challengeId, 'hex');
    vi.spyOn(verifier, 'computeCanonicalChallengeHash').mockResolvedValue(expectedHash);

    // Mock envelope returning envelopeTypeTxFeeBump
    vi.spyOn(xdr.TransactionEnvelope, 'fromXDR').mockReturnValue({
      switch: () => ({ name: 'envelopeTypeTxFeeBump' }),
      feeBump: () => ({
        tx: () => ({
          innerTx: () => ({
            switch: () => ({ name: 'envelopeTypeTx' }),
            v1: () => ({
              tx: () => ({
                operations: () => [{
                  body: () => ({
                    switch: () => ({ name: 'invokeHostFunction' }),
                    invokeHostFunctionOp: () => ({
                      hostFunction: () => ({
                        switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
                        invokeContract: () => ({
                          contractAddress: () => Address.fromString('CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO').toScAddress(),
                          functionName: () => Buffer.from('settle_payment'),
                          args: () => [
                            new Address('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').toScVal(),
                            new Address('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').toScVal(),
                            new Address('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').toScVal(),
                            nativeToScVal(500_000n, { type: 'i128' }),
                            xdr.ScVal.scvBytes(expectedHash),
                          ],
                        }),
                      }),
                    }),
                  }),
                }],
              }),
            }),
          }),
        }),
      }),
    } as any);

    vi.spyOn(verifier as any, 'querySorobanContractReceipt').mockResolvedValue({
      payer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      amount: 500_000n,
      timestamp: 1730000000,
    });

    const result = await verifier.verifyPayment('feebump_tx_hash', challenge, store);
    expect(result.valid).toBe(true);
    expect(result.payer).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  });

  it('rejects malformed challengeId format fail-closed (strict 64-character hex)', async () => {
    const malformedChallenge: X402Challenge = {
      challengeId: 'not_a_valid_hex_string_too_short',
      destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: '0.05',
      asset: 'XLM',
      memo: 'malformed_memo',
      network: 'testnet',
      resource: '/resource',
      expiresAt: Date.now() + 60_000,
    };

    const result = await verifier.verifyPayment('any_tx_hash', malformedChallenge, store);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Malformed challengeId');
    expect(result.reason).toContain('Expected strict 64-character hex string');
  });

  it('returns retriable 503 error when computeCanonicalChallengeHash RPC simulation fails', async () => {
    const challenge = store.createChallenge(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0.05',
      'XLM',
      '/resource'
    );
    challenge.contractId = 'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO';

    vi.spyOn(verifier as any, 'fetchSorobanTxJsonRpc').mockResolvedValue({
      status: 'SUCCESS',
      envelopeXdr: 'AAAA',
    });

    const nonceBytes = Buffer.from(challenge.challengeId, 'hex');

    vi.spyOn(xdr.TransactionEnvelope, 'fromXDR').mockReturnValue({
      value: () => ({
        tx: () => ({
          operations: () => [{
            body: () => ({
              switch: () => ({ name: 'invokeHostFunction' }),
              invokeHostFunctionOp: () => ({
                hostFunction: () => ({
                  switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
                  invokeContract: () => ({
                    contractAddress: () => Address.fromString('CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO').toScAddress(),
                    functionName: () => Buffer.from('settle_payment'),
                    args: () => [
                      new Address('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').toScVal(),
                      new Address('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').toScVal(),
                      new Address('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').toScVal(),
                      nativeToScVal(500_000n, { type: 'i128' }),
                      xdr.ScVal.scvBytes(nonceBytes),
                    ],
                  }),
                }),
              }),
            }),
          }],
        }),
      }),
    } as any);

    // Mock computeCanonicalChallengeHash throwing RPC simulation error
    vi.spyOn(verifier, 'computeCanonicalChallengeHash').mockRejectedValue(
      new Error('Soroban RPC simulation timed out (504)')
    );

    const result = await verifier.verifyPayment('dummy_tx_hash', challenge, store);
    expect(result.valid).toBe(false);
    expect(result.retriable).toBe(true);
    expect(result.statusCode).toBe(503);
    expect(result.reason).toContain('Temporary Soroban RPC simulation failure');
  });

  describe('Adversarial Requester Authentication & Operation Payer Attribution (Conditions 1, 2, 3)', () => {
    it('correctly attributes payment to operation source_account (Account B) when tx source is Account A', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/resource'
      );

      const txSourceKp = Keypair.random(); // Account A (sponsor/relayer)
      const opPayerKp = Keypair.random();  // Account B (actual spender)

      const mockTx = {
        id: 'ab_tx_hash',
        successful: true,
        source_account: txSourceKp.publicKey(),
        memo: challenge.memo,
        ledger_attr: 50001,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              from: opPayerKp.publicKey(),
              source_account: opPayerKp.publicKey(),
              amount: '0.05',
              asset_type: 'native',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({
          call: async () => mockTx,
        }),
      } as any);

      const cleanHash = 'ab_tx_hash';
      const domainMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/resource:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;

      // Case 1: Transaction source A attempts to sign -> REJECTED (anti-substitution / anti-attribution spoofing)
      const sigFromA = txSourceKp.sign(Buffer.from(domainMessage, 'utf-8')).toString('base64');
      const resultA = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: domainMessage,
        signatureBase64: sigFromA,
      });
      expect(resultA.valid).toBe(false);
      expect(resultA.reason).toContain('Requester authentication failed');
      expect(store.isTxRedeemed(cleanHash)).toBe(false);

      // Case 2: Actual operation payer B signs -> APPROVED
      const sigFromB = opPayerKp.sign(Buffer.from(domainMessage, 'utf-8')).toString('base64');
      const resultB = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: domainMessage,
        signatureBase64: sigFromB,
      });
      expect(resultB.valid).toBe(true);
      expect(resultB.payer).toBe(opPayerKp.publicKey());
      expect(store.isTxRedeemed(cleanHash)).toBe(true);
    });

    it('rejects Horizon payment when contributing operations originate from multiple ambiguous payers', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.10',
        'XLM',
        '/resource'
      );

      const payer1Kp = Keypair.random();
      const payer2Kp = Keypair.random();

      const mockMultiTx = {
        id: 'multi_payer_tx',
        successful: true,
        source_account: payer1Kp.publicKey(),
        memo: challenge.memo,
        ledger_attr: 50002,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              source_account: payer1Kp.publicKey(),
              amount: '0.05',
              asset_type: 'native',
            },
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              source_account: payer2Kp.publicKey(),
              amount: '0.05',
              asset_type: 'native',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({
          call: async () => mockMultiTx,
        }),
      } as any);

      const result = await verifier.verifyPayment('multi_payer_tx', challenge, store);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('multiple or ambiguous operation payers detected (2 payers)');
      expect(store.isTxRedeemed('multi_payer_tx')).toBe(false);
    });

    it('rigorously validates signature tampering, wrong key, and message component mutations', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/resource'
      );

      const payerKp = Keypair.random();
      const attackerKp = Keypair.random();

      const mockTx = {
        id: 'tamper_tx_hash',
        successful: true,
        source_account: payerKp.publicKey(),
        memo: challenge.memo,
        ledger_attr: 50003,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              source_account: payerKp.publicKey(),
              amount: '0.05',
              asset_type: 'native',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({
          call: async () => mockTx,
        }),
      } as any);

      const cleanHash = 'tamper_tx_hash';
      const correctMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/resource:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;

      // 1. Signature signed by completely wrong keypair
      const wrongKeySig = attackerKp.sign(Buffer.from(correctMessage, 'utf-8')).toString('base64');
      const resWrongKey = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: correctMessage,
        signatureBase64: wrongKeySig,
      });
      expect(resWrongKey.valid).toBe(false);
      expect(resWrongKey.reason).toContain('Requester authentication failed');

      // 2. Malformed base64 signature
      const resMalformed = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: correctMessage,
        signatureBase64: 'not_valid_base64!!!',
      });
      expect(resMalformed.valid).toBe(false);

      // 3. Mismatched domain message presentation (agent signs msgA for /resource, presents msgB for /different_resource)
      const validSig = payerKp.sign(Buffer.from(correctMessage, 'utf-8')).toString('base64');
      const alteredMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/different_resource:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      const resAlteredMsg = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: alteredMessage,
        signatureBase64: validSig,
      });
      expect(resAlteredMsg.valid).toBe(false);
      expect(resAlteredMsg.reason).toContain('Requester authentication failed');
      expect(store.isTxRedeemed(cleanHash)).toBe(false);

      // 4. Valid authentic signature successfully settles payment and marks redeemed in store
      const resValid = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: correctMessage,
        signatureBase64: validSig,
      });
      expect(resValid.valid).toBe(true);
      expect(resValid.payer).toBe(payerKp.publicKey());
      expect(store.isTxRedeemed(cleanHash)).toBe(true);
    });

    it('correctly falls back to op.from when op.source_account is absent, and op.funder for create_account', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/resource'
      );

      const fromPayerKp = Keypair.random();
      const mockTx = {
        id: 'fallback_from_tx',
        successful: true,
        source_account: 'GRELAYER_SOURCE_1234567890',
        memo: challenge.memo,
        ledger_attr: 50010,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              from: fromPayerKp.publicKey(), // source_account undefined, relies on from
              amount: '0.05',
              asset_type: 'native',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({ call: async () => mockTx }),
      } as any);

      const cleanHash = 'fallback_from_tx';
      const domainMsg = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/resource:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      const validSig = fromPayerKp.sign(Buffer.from(domainMsg, 'utf-8')).toString('base64');

      const result = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: domainMsg,
        signatureBase64: validSig,
      });
      expect(result.valid).toBe(true);
      expect(result.payer).toBe(fromPayerKp.publicKey());
    });

    it('correctly consolidates multiple payments from the SAME payer across multiple pages', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.10',
        'XLM',
        '/resource'
      );

      const singlePayerKp = Keypair.random();
      const mockMultiPageSamePayerTx = {
        id: 'multipage_same_payer_tx',
        successful: true,
        source_account: 'GRELAYER_SOURCE_9999999999',
        memo: challenge.memo,
        ledger_attr: 50011,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              source_account: singlePayerKp.publicKey(),
              amount: '0.06',
              asset_type: 'native',
            },
          ],
          next: async () => ({
            records: [
              {
                type: 'payment',
                to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                source_account: singlePayerKp.publicKey(),
                amount: '0.04',
                asset_type: 'native',
              },
            ],
            next: async () => ({ records: [] }),
          }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({ call: async () => mockMultiPageSamePayerTx }),
      } as any);

      const cleanHash = 'multipage_same_payer_tx';
      const domainMsg = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/resource:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      const validSig = singlePayerKp.sign(Buffer.from(domainMsg, 'utf-8')).toString('base64');

      const result = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: domainMsg,
        signatureBase64: validSig,
      });
      expect(result.valid).toBe(true);
      expect(result.amount).toBe('0.1');
      expect(result.payer).toBe(singlePayerKp.publicKey());
    });

    it('correctly attributes payer to op.funder for create_account operation when tx source is a relayer', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '1.0',
        'XLM',
        '/resource'
      );

      const funderPayerKp = Keypair.random(); // actual funder
      const relayerKp = Keypair.random();     // transaction envelope source

      const mockCreateAccountTx = {
        id: 'funder_create_account_tx',
        successful: true,
        source_account: relayerKp.publicKey(),
        memo: challenge.memo,
        ledger_attr: 50020,
        operations: async () => ({
          records: [
            {
              type: 'create_account',
              account: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', // destination account funded
              funder: funderPayerKp.publicKey(), // funder providing starting balance
              starting_balance: '1.0',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({ call: async () => mockCreateAccountTx }),
      } as any);

      const cleanHash = 'funder_create_account_tx';
      const domainMsg = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/resource:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      const validFunderSig = funderPayerKp.sign(Buffer.from(domainMsg, 'utf-8')).toString('base64');

      const result = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: domainMsg,
        signatureBase64: validFunderSig,
      });

      expect(result.valid).toBe(true);
      expect(result.payer).toBe(funderPayerKp.publicKey());
      expect(result.amount).toBe('1');
      expect(store.isTxRedeemed(cleanHash)).toBe(true);
      expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(true);
    });
    it('rejects payment if challenge expires during Horizon network query and prevents redemption', async () => {
      let horizonQueryReached = false;
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/resource',
        'testnet',
        undefined,
        50 // expires in 50ms
      );

      const payerKp = Keypair.random();
      const cleanHash = 'expiry_race_tx';
      const mockTx = {
        id: cleanHash,
        successful: true,
        source_account: payerKp.publicKey(),
        memo: challenge.memo,
        ledger_attr: 50012,
        operations: async () => {
          horizonQueryReached = true;
          // Simulate ledger query latency that crosses the 50ms expiry boundary
          await new Promise((resolve) => setTimeout(resolve, 80));
          return {
            records: [
              {
                type: 'payment',
                to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                source_account: payerKp.publicKey(),
                amount: '0.05',
                asset_type: 'native',
              },
            ],
            next: async () => ({ records: [] }),
          };
        },
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({ call: async () => mockTx }),
      } as any);

      const domainMsg = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/resource:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      const validSig = payerKp.sign(Buffer.from(domainMsg, 'utf-8')).toString('base64');

      const result = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: domainMsg,
        signatureBase64: validSig,
      });

      // 1. Assert Horizon network query was actually executed and reached
      expect(horizonQueryReached).toBe(true);

      // 2. Assert verifier returns valid: false with atomic expiration failure reason
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/expired/i);

      // 3. Crucial integrity assertions: neither the tx hash nor the challenge is redeemed!
      expect(store.isTxRedeemed(cleanHash)).toBe(false);
      expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);
    });

    it('verifier isolates and rejects domain message presentation mismatch even when passed directly', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/resource'
      );

      const payerKp = Keypair.random();
      const cleanHash = 'context_isolation_tx';
      // Agent signs a message for /different_tool
      const spoofedMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:/different_tool:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      const spoofedSig = payerKp.sign(Buffer.from(spoofedMessage, 'utf-8')).toString('base64');

      // Passing spoofed message directly to verifier.verifyPayment -> verifier detects expected domain mismatch!
      const result = await verifier.verifyPayment(cleanHash, challenge, store, {
        message: spoofedMessage,
        signatureBase64: spoofedSig,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Domain-separated message mismatch');
      expect(store.isTxRedeemed(cleanHash)).toBe(false);
    });

    it('treats SQLITE_BUSY during redemption as temporary unconsumed retriable 503, allows successful retry with same hash/challenge upon lock release, and rejects subsequent replay', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/resource',
        'testnet',
        undefined,
        60_000
      );

      const payerKp = Keypair.random();
      const cleanHash = 'e2e_contention_and_recovery_tx';

      const mockTx = {
        id: cleanHash,
        successful: true,
        source_account: payerKp.publicKey(),
        memo: challenge.memo,
        ledger_attr: 50005,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              from: payerKp.publicKey(),
              source_account: payerKp.publicKey(),
              amount: '0.05',
              asset_type: 'native',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue(mockTx),
        }),
      } as any);

      // Phase 1: Simulate SQLite lock contention (SQLITE_BUSY)
      const sqliteBusyError = new Error('SQLITE_BUSY: database is locked');
      (sqliteBusyError as any).code = 'SQLITE_BUSY';
      const markSpy = vi.spyOn(store, 'markRedeemed').mockImplementationOnce(() => {
        throw sqliteBusyError;
      });

      const busyResult = await verifier.verifyPayment(cleanHash, challenge, store);
      expect(busyResult.valid).toBe(false);
      expect(busyResult.retriable).toBe(true);
      expect(busyResult.statusCode).toBe(503);
      expect(store.isTxRedeemed(cleanHash)).toBe(false);
      expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(false);

      // Phase 2: Lock released! Retry verification with EXACT SAME txHash and challenge
      markSpy.mockRestore(); // Restore genuine markRedeemed
      const recoveryResult = await verifier.verifyPayment(cleanHash, challenge, store);
      expect(recoveryResult.valid).toBe(true);
      expect(recoveryResult.payer).toBe(payerKp.publicKey());
      expect(store.isTxRedeemed(cleanHash)).toBe(true);
      expect(store.isChallengeRedeemed(challenge.challengeId)).toBe(true);

      // Phase 3: Subsequent replay of same txHash is strictly rejected
      const replayResult = await verifier.verifyPayment(cleanHash, challenge, store);
      expect(replayResult.valid).toBe(false);
      expect(replayResult.reason).toContain('Transaction hash has already been redeemed');
    });

    it('verifies Soroban SQLite lock contention -> 503 retriable -> recovery with same proof -> anti-replay rejection', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/soroban-res',
        'testnet',
        'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO',
        60_000
      );

      const payerKp = Keypair.random();
      const cleanHash = 'soroban_contention_recovery_tx';
      const expectedHash = Buffer.from('f'.repeat(64), 'hex');

      const nonceBytes = Buffer.from(challenge.challengeId, 'hex');

      // Mock Soroban computeCanonicalChallengeHash
      vi.spyOn(verifier, 'computeCanonicalChallengeHash').mockResolvedValue(expectedHash);

      // Mock genuine fetchSorobanTxJsonRpc with authentic envelope and operation
      vi.spyOn(verifier as any, 'fetchSorobanTxJsonRpc').mockResolvedValue({
        status: 'SUCCESS',
        latestLedger: 60000,
        envelopeXdr: 'mock_base64_envelope',
      });

      // Mock genuine xdr.TransactionEnvelope.fromXDR matching production verifier logic
      vi.spyOn(xdr.TransactionEnvelope, 'fromXDR').mockReturnValue({
        switch: () => ({ name: 'envelopeTypeTx' }),
        value: () => ({
          tx: () => ({
            operations: () => [{
              body: () => ({
                switch: () => ({ name: 'invokeHostFunction' }),
                invokeHostFunctionOp: () => ({
                  hostFunction: () => ({
                    switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
                    invokeContract: () => ({
                      contractAddress: () => Address.fromString('CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO').toScAddress(),
                      functionName: () => Buffer.from('settle_payment'),
                      args: () => [
                        new Address(payerKp.publicKey()).toScVal(),
                        new Address('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').toScVal(),
                        new Address('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').toScVal(),
                        nativeToScVal(500_000n, { type: 'i128' }),
                        xdr.ScVal.scvBytes(nonceBytes),
                      ],
                    }),
                  }),
                }),
              }),
            }],
          }),
        }),
      } as any);

      // Mock genuine querySorobanContractReceipt
      vi.spyOn(verifier as any, 'querySorobanContractReceipt').mockResolvedValue({
        payer: payerKp.publicKey(),
        recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        amount: 500_000n,
        timestamp: Math.floor(Date.now() / 1000),
        challenge_hash: expectedHash,
      });

      // Phase 1: Lock contention (markRedeemed throws SQLITE_BUSY)
      const sqliteBusyError = new Error('SQLITE_BUSY: database is locked');
      (sqliteBusyError as any).code = 'SQLITE_BUSY';
      const markSpy = vi.spyOn(store, 'markRedeemed').mockImplementationOnce(() => {
        throw sqliteBusyError;
      });

      // Execute production verifyPayment and verifySorobanTransactionAndReceipt without mocking the method!
      const busyResult = await verifier.verifyPayment(cleanHash, challenge, store);
      expect(busyResult.valid).toBe(false);
      expect(busyResult.retriable).toBe(true);
      expect(busyResult.statusCode).toBe(503);
      expect(busyResult.reason).toContain('Database busy under writer contention');

      // Phase 2: Lock released -> Success with same proof through production verifier
      markSpy.mockRestore();
      const recoveryResult = await verifier.verifyPayment(cleanHash, challenge, store);
      expect(recoveryResult.valid).toBe(true);
      expect(recoveryResult.payer).toBe(payerKp.publicKey());

      // Phase 3: Anti-replay rejection
      const replayResult = await verifier.verifyPayment(cleanHash, challenge, store);
      expect(replayResult.valid).toBe(false);
      expect(replayResult.reason).toContain('Transaction hash has already been redeemed');
    });

    it('recovers confirmed on-chain payment whose challenge expired during SQLite lock contention within safety grace period', async () => {
      // Challenge created with only 50ms TTL
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/grace-res',
        'testnet',
        undefined,
        50
      );

      const payerKp = Keypair.random();
      const cleanHash = 'grace_recovery_tx';

      const mockTx = {
        id: cleanHash,
        successful: true,
        source_account: payerKp.publicKey(),
        memo: challenge.memo,
        ledger_attr: 50010,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              from: payerKp.publicKey(),
              source_account: payerKp.publicKey(),
              amount: '0.05',
              asset_type: 'native',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue(mockTx),
        }),
      } as any);

      // Wait 80ms so challenge naturally expires past its 50ms TTL
      await new Promise(resolve => setTimeout(resolve, 80));

      // Without grace period: verification fails because challenge expired
      const expiredResult = await verifier.verifyPayment(cleanHash, challenge, store, undefined, 0);
      expect(expiredResult.valid).toBe(false);
      expect(expiredResult.reason).toMatch(/expired/i);

      // With grace period policy (e.g. 60,000ms grace window for lock contention recovery):
      // Challenge successfully settles without requiring a second payment!
      const graceResult = await verifier.verifyPayment(cleanHash, challenge, store, undefined, 60_000);
      expect(graceResult.valid).toBe(true);
      expect(graceResult.payer).toBe(payerKp.publicKey());
      expect(store.isTxRedeemed(cleanHash)).toBe(true);
    });

    it('correctly classifies transient Soroban RPC failures (fetch failed, ECONNRESET, JSON-RPC -32603) as retriable 503 instead of false payment rejection', async () => {
      const challenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/soroban-rpc-transient',
        'testnet',
        'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO',
        60_000
      );

      // 1. Injected TypeError('fetch failed') with cause.code = 'ECONNRESET'
      const connResetError = new TypeError('fetch failed');
      (connResetError as any).cause = { code: 'ECONNRESET' };
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(connResetError);

      const connResetResult = await verifier.verifyPayment('tx_conn_reset', challenge, store);
      expect(connResetResult.valid).toBe(false);
      expect(connResetResult.retriable).toBe(true);
      expect(connResetResult.statusCode).toBe(503);
      expect(connResetResult.reason).toContain('Soroban RPC getTransaction network timeout/transient failure');

      // 2. Injected JSON-RPC -32603 internal error response
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32603, message: 'Internal error: node catching up' },
        }),
      } as any);

      const rpcInternalResult = await verifier.verifyPayment('tx_rpc_internal', challenge, store);
      expect(rpcInternalResult.valid).toBe(false);
      expect(rpcInternalResult.retriable).toBe(true);
      expect(rpcInternalResult.statusCode).toBe(503);
      expect(rpcInternalResult.reason).toContain('Soroban JSON-RPC transient error (-32603)');

      // 3. Injected neutral error message with cause.code = 'EAI_AGAIN'
      const eaiAgainError = new Error('getaddrinfo failure');
      (eaiAgainError as any).cause = { code: 'EAI_AGAIN' };
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(eaiAgainError);

      const eaiAgainResult = await verifier.verifyPayment('tx_eai_again', challenge, store);
      expect(eaiAgainResult.valid).toBe(false);
      expect(eaiAgainResult.retriable).toBe(true);
      expect(eaiAgainResult.statusCode).toBe(503);

      // 4. Injected neutral error message with cause.code = 'ETIMEDOUT'
      const etimedoutError = new Error('socket closed');
      (etimedoutError as any).cause = { code: 'ETIMEDOUT' };
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(etimedoutError);

      const etimedoutResult = await verifier.verifyPayment('tx_etimedout', challenge, store);
      expect(etimedoutResult.valid).toBe(false);
      expect(etimedoutResult.retriable).toBe(true);
      expect(etimedoutResult.statusCode).toBe(503);

      // 5. Injected HTTP 429 Rate Limit
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      } as any);

      const rateLimitResult = await verifier.verifyPayment('tx_rate_limit', challenge, store);
      expect(rateLimitResult.valid).toBe(false);
      expect(rateLimitResult.retriable).toBe(true);
      expect(rateLimitResult.statusCode).toBe(503);

      // 6. Injected HTTP 520 / 5xx Cloudflare / Gateway Error
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 520,
        statusText: 'Web Server Returned an Unknown Error',
      } as any);

      const http520Result = await verifier.verifyPayment('tx_520', challenge, store);
      expect(http520Result.valid).toBe(false);
      expect(http520Result.retriable).toBe(true);
      expect(http520Result.statusCode).toBe(503);

      // 7. Injected querySorobanContractReceipt network failure with cause.code = 'ECONNRESET'
      const receiptConnReset = new TypeError('fetch failed');
      (receiptConnReset as any).cause = { code: 'ECONNRESET' };
      vi.spyOn((verifier as any).sorobanServer, 'getContractData').mockRejectedValueOnce(receiptConnReset);

      await expect(verifier.querySorobanContractReceipt(
        'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO',
        Buffer.from('f'.repeat(64), 'hex')
      )).rejects.toThrow('Soroban RPC getContractData transient network failure');

      // 8. Full End-to-End Soroban pipeline test: receipt query failure propagates to HTTP 503 retriable in verifyPayment
      const sorobanChallenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/soroban-resource',
        'testnet',
        'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO'
      );
      const validTxHash = 'e'.repeat(64);
      vi.spyOn(verifier, 'fetchSorobanTxJsonRpc').mockResolvedValueOnce({
        status: 'SUCCESS',
        envelopeXdr: 'AAAA',
      });
      const expectedNonce = Buffer.from(sorobanChallenge.challengeId, 'hex');
      const validAgentKp = Keypair.random();
      vi.spyOn(xdr.TransactionEnvelope, 'fromXDR').mockReturnValueOnce({
        value: () => ({
          tx: () => ({
            operations: () => [{
              body: () => ({
                switch: () => ({ name: 'invokeHostFunction' }),
                invokeHostFunctionOp: () => ({
                  hostFunction: () => ({
                    switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
                    invokeContract: () => ({
                      contractAddress: () => Address.fromString('CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO').toScAddress(),
                      functionName: () => Buffer.from('settle_payment'),
                      args: () => [
                        new Address(validAgentKp.publicKey()).toScVal(),
                        new Address(sorobanChallenge.destination).toScVal(),
                        new Address('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').toScVal(),
                        nativeToScVal(500_000n, { type: 'i128' }),
                        xdr.ScVal.scvBytes(expectedNonce),
                      ],
                    }),
                  }),
                }),
              }),
            }],
          }),
        }),
      } as any);

      // Mock simulateTransaction for canonical hash
      vi.spyOn((verifier as any).sorobanServer, 'simulateTransaction').mockResolvedValueOnce({
        result: {
          retval: {
            bytes: () => Buffer.from('a'.repeat(64), 'hex'),
          },
        },
      });
      // Mock getContractData with 501 / 550 / 599 / Axios ERR_BAD_RESPONSE with response.status = 520
      const axios520Err = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Bad response',
        response: { status: 520 },
      };
      vi.spyOn((verifier as any).sorobanServer, 'getContractData').mockRejectedValueOnce(axios520Err);

      const receiptE2EResult = await verifier.verifyPayment(validTxHash, sorobanChallenge, store);
      expect(receiptE2EResult.valid).toBe(false);
      expect(receiptE2EResult.retriable).toBe(true);
      expect(receiptE2EResult.statusCode).toBe(503);
      expect(receiptE2EResult.reason).toContain('Soroban RPC transient infrastructure failure');
      // Anti-replay store must NOT have redeemed the challenge or transaction
      expect(store.isTxRedeemed(validTxHash)).toBe(false);
      expect(store.isChallengeRedeemed(sorobanChallenge.challengeId)).toBe(false);

      // 9. Horizon Horizon Server Error (HTTP 520 / 500 / 502) propagates to retriable 503 instead of false 402 rejection
      const horizonChallenge = store.createChallenge(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0.05',
        'XLM',
        '/horizon-resource'
      );
      const horizon520Error = new Error('Request failed with status code 520');
      (horizon520Error as any).response = { status: 520 };
      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValueOnce({
        transaction: () => ({
          call: async () => { throw horizon520Error; },
        }),
      } as any);

      const horizon520Result = await verifier.verifyPayment('horizon_tx_520', horizonChallenge, store);
      expect(horizon520Result.valid).toBe(false);
      expect(horizon520Result.retriable).toBe(true);
      expect(horizon520Result.statusCode).toBe(520);
      expect(horizon520Result.reason).toContain('Stellar Horizon transient infrastructure failure');
      // Must not consume challenge or tx
      expect(store.isTxRedeemed('horizon_tx_520')).toBe(false);
      expect(store.isChallengeRedeemed(horizonChallenge.challengeId)).toBe(false);

      // 10. Demonstrated key absence (code: 404) in querySorobanContractReceipt returns null, NOT a 503
      vi.spyOn((verifier as any).sorobanServer, 'getContractData').mockRejectedValueOnce({
        code: 404,
        message: 'Contract data not found. Contract: CB5DW4..., Key: ..., Durability: persistent',
      });
      const receiptNotFound = await verifier.querySorobanContractReceipt(
        'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO',
        Buffer.from('f'.repeat(64), 'hex')
      );
      expect(receiptNotFound).toBeNull();
    });
  });
});
