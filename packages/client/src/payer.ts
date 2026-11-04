import crypto from 'node:crypto';
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  Contract,
  Address,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { ClientConfig, ParsedChallenge, ClientPaymentReceipt } from './types.js';

const TESTNET_NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PUBLIC_NATIVE_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

export function amountToStroops(amount: string | number): bigint {
  const str = String(amount).trim();
  if (!str || str.startsWith('-')) {
    throw new Error(`Invalid payment amount: '${amount}'. Amount must be positive.`);
  }

  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid payment amount format: '${amount}'. Expected valid numeric string.`);
  }

  const [whole, fraction = ''] = str.split('.');
  if (fraction.length > 7) {
    throw new Error(`Excess decimal precision in '${amount}'. Stellar SAC tokens support at most 7 decimal places (stroops).`);
  }

  const paddedFraction = fraction.padEnd(7, '0');
  const stroops = BigInt(whole) * 10_000_000n + BigInt(paddedFraction);
  if (stroops <= 0n) {
    throw new Error(`Payment amount must be greater than zero stroops, got: '${amount}'`);
  }
  return stroops;
}

/**
 * Standard RFC 7159 / JSON-RPC 2.0 query to Soroban RPC for transaction status.
 * Replaces any reliance on private SDK methods.
 */
async function fetchSorobanTxJsonRpc(rpcUrl: string, txHash: string): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: { hash: txHash },
    }),
  });
  if (!response.ok) {
    throw new Error(`Soroban JSON-RPC HTTP error: ${response.status} ${response.statusText}`);
  }
  const json: any = await response.json();
  if (json.error) {
    throw new Error(`Soroban JSON-RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

export class StellarPayer {
  private keypair: Keypair;
  private horizonServer: Horizon.Server;
  private sorobanServer: rpc.Server;
  private networkPassphrase: string;
  private network: string;
  private sorobanRpcUrl: string;

  constructor(private config: ClientConfig) {
    this.keypair = Keypair.fromSecret(config.secretKey);
    this.network = config.network || 'testnet';
    this.horizonServer = new Horizon.Server(
      config.horizonUrl || 'https://horizon-testnet.stellar.org'
    );
    this.sorobanRpcUrl =
      config.sorobanRpcUrl || 'https://soroban-testnet.stellar.org';
    this.sorobanServer = new rpc.Server(this.sorobanRpcUrl);
    this.networkPassphrase =
      this.network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  public getPublicKey(): string {
    return this.keypair.publicKey();
  }

  public getKeypair(): Keypair {
    return this.keypair;
  }

  /**
   * Cryptographically sign proof of challenge ownership for anti-front-running redemption
   * Includes strict domain separation: protocol version, network passphrase, gateway URL, challengeId, txHash, and expiration.
   */
  public signRequesterProof(
    challengeId: string,
    txHash: string,
    gatewayUrl: string = 'default',
    expiresAt: number = 0
  ): string {
    const domainPrefix = `stellar-x402:v1:${this.networkPassphrase}:${gatewayUrl}:${challengeId}:${txHash}:${expiresAt}`;
    const message = Buffer.from(domainPrefix, 'utf-8');
    return this.keypair.sign(message).toString('base64');
  }

  /**
   * Settle an x402 challenge.
   * Automatically routes to Soroban Smart Contract if contractId is present,
   * otherwise executes a classic Stellar payment.
   */
  public async settleChallenge(challenge: ParsedChallenge): Promise<ClientPaymentReceipt> {
    // 0. Client Policy: Network passphrase validation
    if (challenge.network && challenge.network !== this.network) {
      throw new Error(
        `Network mismatch: Challenge specified network '${challenge.network}', but client is configured for '${this.network}'`
      );
    }

    // 1. Client Policy: Hard cap per single tool call
    const maxPerCall = this.config.maxPaymentPerCallXlm ?? 1.0;
    const requestedAmount = parseFloat(challenge.amount);
    if (requestedAmount > maxPerCall) {
      throw new Error(
        `Payment amount of ${challenge.amount} XLM exceeds client maxPaymentPerCall limit of ${maxPerCall} XLM`
      );
    }

    // 2. Client Policy: Destination address whitelist
    if (this.config.allowedDestinations && !this.config.allowedDestinations.includes(challenge.destination)) {
      throw new Error(
        `Destination address '${challenge.destination}' rejected: not in client allowedDestinations whitelist`
      );
    }

    // 3. Client Policy: Asset / Token whitelist
    if (this.config.allowedTokens && !this.config.allowedTokens.includes(challenge.asset)) {
      throw new Error(
        `Asset '${challenge.asset}' rejected: not in client allowedTokens whitelist`
      );
    }

    // 4. Client Policy: Vault contract pinning
    if (this.config.pinnedVaultContractId && challenge.contractId && challenge.contractId !== this.config.pinnedVaultContractId) {
      throw new Error(
        `Untrusted vault contract '${challenge.contractId}' rejected by client policy (expected: '${this.config.pinnedVaultContractId}')`
      );
    }

    const contractId = this.config.pinnedVaultContractId || challenge.contractId || this.config.contractId;
    if (contractId) {
      return this.settleSorobanChallenge({ ...challenge, contractId });
    }
    return this.settleClassicChallenge(challenge);
  }

  /**
   * Autonomous Soroban Smart Contract settlement:
   * Calls X402PaymentVault.settle_payment(payer, recipient, token, amount, challenge_hash)
   */
  public async settleSorobanChallenge(challenge: ParsedChallenge): Promise<ClientPaymentReceipt> {
    const contractId = challenge.contractId || this.config.contractId;
    if (!contractId) {
      throw new Error('Soroban settlement requires a contractId in challenge or client config');
    }

    const payerAddress = this.keypair.publicKey();
    const recipientAddress = challenge.destination;

    // Resolve SAC token contract address
    let tokenAddress = challenge.tokenAddress;
    if (!tokenAddress) {
      const isNative =
        challenge.asset.toUpperCase() === 'XLM' || challenge.asset.toUpperCase() === 'NATIVE';
      if (isNative) {
        tokenAddress =
          this.networkPassphrase === Networks.PUBLIC ? PUBLIC_NATIVE_SAC : TESTNET_NATIVE_SAC;
      } else {
        throw new Error(
          `Soroban SAC token address required for non-native asset '${challenge.asset}'.`
        );
      }
    }

    // Convert amount to stroops
    const amountStroops = amountToStroops(challenge.amount);

    // Compute 32-byte challenge hash buffer
    let hashBytes: Buffer;
    if (challenge.challengeId.length === 64) {
      hashBytes = Buffer.from(challenge.challengeId, 'hex');
    } else {
      hashBytes = crypto.createHash('sha256').update(challenge.challengeId).digest();
    }

    // Load account sequence number from Soroban RPC
    const account = await this.sorobanServer.getAccount(payerAddress);

    // Construct contract call: settle_payment(payer, recipient, token, amount, challenge_hash)
    const contract = new Contract(contractId);
    const op = contract.call(
      'settle_payment',
      new Address(payerAddress).toScVal(),
      new Address(recipientAddress).toScVal(),
      new Address(tokenAddress).toScVal(),
      nativeToScVal(amountStroops, { type: 'i128' }),
      xdr.ScVal.scvBytes(hashBytes)
    );

    const tx = new TransactionBuilder(account, {
      fee: '100000', // 0.01 XLM base fee envelope
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();

    // Prepare transaction on Soroban (calculates ledger footprints, resource fees and auth entries)
    const prepared = await this.sorobanServer.prepareTransaction(tx);

    // Client Security Policy: Recursively inspect simulated auth tree before signing
    if (this.config.validateSimulationAuth !== false) {
      try {
        const allowedContracts = new Set([contractId, tokenAddress]);
        const checkInvocation = (inv: any) => {
          if (!inv) return;
          if (typeof inv.contractAddress === 'function') {
            const targetContract = Address.fromScAddress(inv.contractAddress()).toString();
            if (!allowedContracts.has(targetContract)) {
              throw new Error(
                `Malicious auth tree detected: simulation attempted authorization on unauthorized contract '${targetContract}'`
              );
            }
          }
          if (typeof inv.subInvocations === 'function') {
            const subs = inv.subInvocations() || [];
            for (const sub of subs) {
              checkInvocation(sub);
            }
          }
        };

        const ops = (prepared as any).operations || [];
        for (const operation of ops) {
          if (operation.auth && Array.isArray(operation.auth)) {
            for (const authEntry of operation.auth) {
              const rootInvocation =
                typeof authEntry.rootInvocation === 'function'
                  ? authEntry.rootInvocation()
                  : null;
              checkInvocation(rootInvocation);
            }
          }
        }
      } catch (authErr: any) {
        if (authErr.message?.includes('Malicious auth tree detected')) throw authErr;
      }
    }

    // Sign transaction with payer keypair
    // Sign transaction with payer keypair
    prepared.sign(this.keypair);

    // Cryptographic identity and bounds extracted locally prior to broadcast:
    const localTxHash = (prepared as any).hash().toString('hex');
    const signedMaxTimeSec = (prepared as any).timeBounds?.maxTime ? Number((prepared as any).timeBounds.maxTime) : Math.floor(Date.now() / 1000) + 60;
    let ledger: number | undefined;

    // Submit transaction to Soroban RPC with comprehensive post-broadcast error enrichment
    try {
      const sendRes = await this.sorobanServer.sendTransaction(prepared);

      if (sendRes?.status === 'ERROR') {
        throw new Error('Soroban transaction submission failed');
      }

      const returnedHash = typeof sendRes?.hash === 'string' ? sendRes.hash : undefined;
      if (returnedHash && returnedHash.toLowerCase() !== localTxHash.toLowerCase()) {
        throw new Error('RPC returned mismatched transaction hash');
      }
      const txHash = localTxHash;

      // Poll for ledger inclusion safely using standard JSON-RPC 2.0 (protocol-version agnostic)
      let status: string = sendRes?.status;
      let ledger: number | undefined;
      const maxPollAttempts = 30;

      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));

        try {
          const rawTx = await fetchSorobanTxJsonRpc(this.sorobanRpcUrl, txHash);
          if (rawTx) {
            status = rawTx.status;
            ledger = rawTx.ledger || rawTx.latestLedger;
            if (status === 'SUCCESS') {
              break;
            }
            if (status === 'FAILED') {
              throw new Error('Soroban settlement transaction failed on-chain');
            }
          }
        } catch (pollErr: any) {
          if (pollErr.message?.includes('failed on-chain')) throw pollErr;
        }
      }

      if (status !== 'SUCCESS') {
        throw new Error('Soroban transaction timed out waiting for inclusion');
      }
    } catch (postBroadcastErr: any) {
      if (!postBroadcastErr.txHash) postBroadcastErr.txHash = localTxHash;
      if (!postBroadcastErr.maxTime) postBroadcastErr.maxTime = signedMaxTimeSec;
      throw postBroadcastErr;
    }
    return {
      txHash: localTxHash,
      challengeId: challenge.challengeId,
      destination: challenge.destination,
      amount: challenge.amount,
      asset: challenge.asset,
      ledger,
      timestamp: Date.now(),
    };
  }

  /**
   * Classic Stellar Horizon payment settlement
   */
  public async settleClassicChallenge(challenge: ParsedChallenge): Promise<ClientPaymentReceipt> {
    const sourceAccount = await this.horizonServer.loadAccount(this.keypair.publicKey());

    // Build Asset
    let asset: Asset;
    if (challenge.asset.toUpperCase() === 'XLM' || challenge.asset.toUpperCase() === 'NATIVE') {
      asset = Asset.native();
    } else {
      const [code, issuer] = challenge.asset.split(':');
      if (!code || !issuer) {
        throw new Error(
          `Invalid asset format: ${challenge.asset}. Expected 'CODE:ISSUER' or 'XLM'`
        );
      }
      asset = new Asset(code, issuer);
    }

    // Horizon memo text max 28 bytes
    const memoText = (challenge.memo || challenge.challengeId).slice(0, 28);

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '10000', // 10,000 stroops (0.001 XLM base fee for fast inclusion)
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: challenge.destination,
          asset,
          amount: challenge.amount,
        })
      )
      .addMemo(Memo.text(memoText))
      .setTimeout(60)
      .build();

    transaction.sign(this.keypair);

    const localTxHash = transaction.hash().toString('hex');
    const signedMaxTimeSec = transaction.timeBounds?.maxTime ? Number(transaction.timeBounds.maxTime) : Math.floor(Date.now() / 1000) + 60;

    let result: any;
    try {
      result = await this.horizonServer.submitTransaction(transaction);
      const returnedHash = typeof result?.hash === 'string' ? result.hash : undefined;
      if (returnedHash && returnedHash.toLowerCase() !== localTxHash.toLowerCase()) {
        throw new Error('Horizon returned mismatched transaction hash');
      }
    } catch (submitErr: any) {
      if (!submitErr.txHash) submitErr.txHash = localTxHash;
      if (!submitErr.maxTime) submitErr.maxTime = signedMaxTimeSec;
      throw submitErr;
    }

    return {
      txHash: localTxHash,
      challengeId: challenge.challengeId,
      destination: challenge.destination,
      amount: challenge.amount,
      asset: challenge.asset,
      ledger: result.ledger,
      timestamp: Date.now(),
    };
  }
}
