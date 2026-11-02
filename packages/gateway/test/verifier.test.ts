import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StellarPaymentVerifier, amountToStroops } from '../src/verifier.js';
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
});
