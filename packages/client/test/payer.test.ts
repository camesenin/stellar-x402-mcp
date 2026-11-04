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

    it('rejects hostile server attempting to inject unauthorized contract in Soroban simulation auth tree', async () => {
      const payer = new StellarPayer({
        secretKey: dummySecret,
        network: 'testnet',
        validateSimulationAuth: true,
      });

      const canonicalVault = 'CDO7YEKIEYIJ7KV3S4BGIEVNW3JVEGYLV5Q4525LBK2HNUOULFQ3UPL3';
      const nativeSac = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
      const rogueContract = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

      const { Account, Address } = await import('@stellar/stellar-sdk');
      vi.spyOn((payer as any).sorobanServer, 'getAccount').mockResolvedValue(
        new Account(payer.getPublicKey(), '100')
      );

      // Mock simulation returning prepared tx with malicious auth tree
      const mockPreparedTx = {
        operations: [{
          auth: [{
            rootInvocation: () => ({
              contractAddress: () => Address.fromString(canonicalVault).toScAddress(),
              subInvocations: () => [{
                // Malicious nested invocation targeting an unauthorized rogue contract
                contractAddress: () => Address.fromString(rogueContract).toScAddress(),
                subInvocations: () => [],
              }],
            }),
          }],
        }],
        sign: vi.fn(),
        toXDR: vi.fn().mockReturnValue('dummy_xdr'),
      };

      vi.spyOn((payer as any).sorobanServer, 'prepareTransaction').mockResolvedValue(mockPreparedTx);

      const challenge: ParsedChallenge = {
        challengeId: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '0.05',
        asset: 'XLM',
        network: 'testnet',
        contractId: canonicalVault,
        tokenAddress: nativeSac,
      };

      await expect(payer.settleSorobanChallenge(challenge)).rejects.toThrow(
        /Malicious auth tree detected: simulation attempted authorization on unauthorized contract/
      );
      // Ensure transaction was NEVER signed!
      expect(mockPreparedTx.sign).not.toHaveBeenCalled();
    });
  });

  describe('Post-broadcast identity enrichment and adversarial error handling', () => {
    it('enriches primitive string exceptions and null responses with localTxHash and signedMaxTimeSec in Classic settlement', async () => {
      const payer = new StellarPayer({
        secretKey: dummySecret,
        network: 'testnet',
      });

      const { Account } = await import('@stellar/stellar-sdk');
      vi.spyOn((payer as any).horizonServer, 'loadAccount').mockResolvedValue(
        new Account(payer.getPublicKey(), '100')
      );

      const challenge: ParsedChallenge = {
        challengeId: 'test-challenge-classic-null',
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '0.05',
        asset: 'XLM',
        network: 'testnet',
      };

      // Adversarial scenario 1A: Horizon submitTransaction returns null -> MUST FAIL CLOSED with localTxHash & maxTime!
      vi.spyOn((payer as any).horizonServer, 'submitTransaction').mockResolvedValueOnce(null);

      try {
        await payer.settleClassicChallenge(challenge);
        expect.unreachable('Should have thrown on null Horizon response');
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('returned invalid or empty response');
        expect(err.txHash).toBeDefined();
        expect(err.maxTime).toBeGreaterThan(0);
      }

      // Adversarial scenario 1B: Horizon submitTransaction returns empty object or successful: false
      vi.spyOn((payer as any).horizonServer, 'submitTransaction').mockResolvedValueOnce({ successful: false });

      try {
        await payer.settleClassicChallenge(challenge);
        expect.unreachable('Should have thrown on failed Horizon response');
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('failed on-chain');
        expect(err.txHash).toBeDefined();
        expect(err.maxTime).toBeGreaterThan(0);
      }

      // Adversarial scenario 2: Horizon throws a primitive string
      vi.spyOn((payer as any).horizonServer, 'submitTransaction').mockRejectedValueOnce('Horizon internal socket hangup');

      try {
        await payer.settleClassicChallenge(challenge);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('Horizon internal socket hangup');
        expect(err.txHash).toBeDefined();
        expect(err.maxTime).toBeGreaterThan(0);
      }

      // Adversarial scenario 3: Horizon throws a frozen Error object with conflicting txHash
      const foreignErr = new Error('Foreign network error');
      (foreignErr as any).txHash = 'FOREIGN_HASH';
      (foreignErr as any).maxTime = 1;
      const frozenErr = Object.freeze(foreignErr);
      vi.spyOn((payer as any).horizonServer, 'submitTransaction').mockRejectedValueOnce(frozenErr);

      try {
        await payer.settleClassicChallenge(challenge);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.txHash).not.toBe('FOREIGN_HASH');
        expect(err.txHash).toBeDefined();
        expect(err.maxTime).toBeGreaterThan(100);
      }

      // Adversarial scenario 4: Horizon throws unstringifiable object (Object.create(null))
      const unstringifiable = Object.create(null);
      vi.spyOn((payer as any).horizonServer, 'submitTransaction').mockRejectedValueOnce(unstringifiable);

      try {
        await payer.settleClassicChallenge(challenge);
        expect.unreachable('Should have thrown on unstringifiable error');
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.txHash).toBeDefined();
        expect(err.maxTime).toBeGreaterThan(0);
      }
    });
  });
});