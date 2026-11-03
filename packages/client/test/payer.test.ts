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

  describe('Client Security Policies & Malicious 402 Server Defenses', () => {
    it('blocks challenge exceeding maxPaymentPerCallXlm hard limit', async () => {
      const payer = new StellarPayer({
        secretKey: dummySecret,
        network: 'testnet',
        maxPaymentPerCallXlm: 0.5,
      });

      const expensiveChallenge: ParsedChallenge = {
        challengeId: 'expensive-server',
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '2.5', // 2.5 > 0.5 cap
        asset: 'XLM',
        network: 'testnet',
      };

      await expect(payer.settleChallenge(expensiveChallenge)).rejects.toThrow(
        /exceeds client maxPaymentPerCall limit of 0.5 XLM/
      );
    });

    it('blocks challenge with destination not in allowedDestinations allowlist', async () => {
      const trustedMerchant = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const rogueServer = 'GACVH6NMMZ2Y7V64B5L7N3L66S6FUG65476R74LOUX44R6HAKKOCZ776';

      const payer = new StellarPayer({
        secretKey: dummySecret,
        network: 'testnet',
        allowedDestinations: [trustedMerchant],
      });

      const maliciousChallenge: ParsedChallenge = {
        challengeId: 'phishing-tool',
        destination: rogueServer,
        amount: '0.1',
        asset: 'XLM',
        network: 'testnet',
      };

      await expect(payer.settleChallenge(maliciousChallenge)).rejects.toThrow(
        /rejected: not in client allowedDestinations whitelist/
      );
    });

    it('blocks challenge with asset not in allowedTokens allowlist', async () => {
      const payer = new StellarPayer({
        secretKey: dummySecret,
        network: 'testnet',
        allowedTokens: ['XLM'],
      });

      const foreignTokenChallenge: ParsedChallenge = {
        challengeId: 'drain-usdc',
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '0.1',
        asset: 'USDC',
        network: 'testnet',
      };

      await expect(payer.settleChallenge(foreignTokenChallenge)).rejects.toThrow(
        /rejected: not in client allowedTokens whitelist/
      );
    });

    it('blocks challenge specifying foreign vault contract when pinnedVaultContractId is configured', async () => {
      const canonicalVault = 'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO';
      const attackerContract = 'CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA';

      const payer = new StellarPayer({
        secretKey: dummySecret,
        network: 'testnet',
        pinnedVaultContractId: canonicalVault,
      });

      const rogueChallenge: ParsedChallenge = {
        challengeId: 'rogue-vault-attack',
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '0.1',
        asset: 'XLM',
        network: 'testnet',
        contractId: attackerContract,
      };

      await expect(payer.settleChallenge(rogueChallenge)).rejects.toThrow(
        /Untrusted vault contract .* rejected by client policy/
      );
    });

    it('blocks challenge specifying mismatched network passphrase', async () => {
      const payer = new StellarPayer({
        secretKey: dummySecret,
        network: 'testnet',
      });

      const badNetworkChallenge: ParsedChallenge = {
        challengeId: 'spoofed-network',
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '0.1',
        asset: 'XLM',
        network: 'public', // Client is testnet, challenge asks for public!
      };

      await expect(payer.settleChallenge(badNetworkChallenge)).rejects.toThrow(
        /Network mismatch: Challenge specified network 'public'/
      );
    });
  });
});
