import { describe, it, expect } from 'vitest';
import { parseX402Challenge } from '../src/parser.js';

describe('parseX402Challenge', () => {
  it('parses challenge from HTTP headers', () => {
    const headers = new Headers();
    headers.set('x-challenge-id', 'challenge-abc-123');
    headers.set('x-payment-address', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    headers.set('x-payment-amount', '0.05');
    headers.set('x-payment-asset', 'XLM');
    headers.set('x-payment-memo', 'challenge-memo-123');
    headers.set('x-payment-network', 'testnet');

    const result = parseX402Challenge(headers);

    expect(result.challengeId).toBe('challenge-abc-123');
    expect(result.destination).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(result.amount).toBe('0.05');
    expect(result.asset).toBe('XLM');
    expect(result.memo).toBe('challenge-memo-123');
    expect(result.network).toBe('testnet');
  });

  it('parses challenge from JSON body payload', () => {
    const headers = new Headers();
    const jsonBody = {
      status: 402,
      challenge: {
        challengeId: 'json-challenge-99',
        destination: 'GDESTINATION9999999999999999999999999999999999999999999999',
        amount: '0.1',
        asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        memo: 'json-memo-99',
        network: 'testnet',
      },
    };

    const result = parseX402Challenge(headers, jsonBody);

    expect(result.challengeId).toBe('json-challenge-99');
    expect(result.amount).toBe('0.1');
    expect(result.asset).toContain('USDC');
  });

  it('parses challenge from WWW-Authenticate header fallback', () => {
    const headers = new Headers();
    headers.set(
      'www-authenticate',
      'StellarX402 challenge_id="auth-nonce-777", destination="GAUTHDESTINATION", amount="0.02", asset="XLM", memo="auth-memo-777"'
    );

    const result = parseX402Challenge(headers);

    expect(result.challengeId).toBe('auth-nonce-777');
    expect(result.destination).toBe('GAUTHDESTINATION');
    expect(result.amount).toBe('0.02');
  });
});
