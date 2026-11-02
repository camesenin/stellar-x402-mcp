import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { StellarPayer, amountToStroops } from '../src/payer.js';
import { ParsedChallenge } from '../src/types.js';

describe('StellarPayer & Autonomous Soroban Execution', () => {
  const dummySecret = Keypair.random().secret();

  it('correctly converts decimal strings to stroops bigint', () => {
    expect(amountToStroops('0.1')).toBe(1_000_000n);
    expect(amountToStroops('0.0000001')).toBe(1n);
    expect(amountToStroops('5.5')).toBe(55_000_000n);
  });

  it('initializes with secret key and derives valid public key', () => {
    const payer = new StellarPayer({
      secretKey: dummySecret,
      network: 'testnet',
    });

    const pubKey = payer.getPublicKey();
    expect(pubKey.startsWith('G')).toBe(true);
    expect(pubKey.length).toBe(56);
  });

  it('routes to settleSorobanChallenge when contractId is specified', async () => {
    const payer = new StellarPayer({
      secretKey: dummySecret,
      network: 'testnet',
    });

    const sorobanSpy = vi.spyOn(payer, 'settleSorobanChallenge').mockResolvedValueOnce({
      txHash: 'deadbeef1234',
      challengeId: 'test-challenge',
      destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: '0.05',
      asset: 'XLM',
      timestamp: Date.now(),
    });

    const challenge: ParsedChallenge = {
      challengeId: 'test-challenge',
      destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: '0.05',
      asset: 'XLM',
      memo: 'memo123',
      network: 'testnet',
      contractId: 'CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA',
    };

    const receipt = await payer.settleChallenge(challenge);
    expect(sorobanSpy).toHaveBeenCalledWith(challenge);
    expect(receipt.txHash).toBe('deadbeef1234');
  });

  it('routes to settleClassicChallenge when contractId is NOT specified', async () => {
    const payer = new StellarPayer({
      secretKey: dummySecret,
      network: 'testnet',
    });

    const classicSpy = vi.spyOn(payer, 'settleClassicChallenge').mockResolvedValueOnce({
      txHash: 'feedface5678',
      challengeId: 'classic-challenge',
      destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: '0.01',
      asset: 'XLM',
      timestamp: Date.now(),
    });

    const challenge: ParsedChallenge = {
      challengeId: 'classic-challenge',
      destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: '0.01',
      asset: 'XLM',
      memo: 'memo123',
      network: 'testnet',
    };

    const receipt = await payer.settleChallenge(challenge);
    expect(classicSpy).toHaveBeenCalledWith(challenge);
    expect(receipt.txHash).toBe('feedface5678');
  });
});
