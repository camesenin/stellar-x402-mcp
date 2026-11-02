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

export class StellarPayer {
  private keypair: Keypair;
  private horizonServer: Horizon.Server;
  private sorobanServer: rpc.Server;
  private networkPassphrase: string;

  constructor(private config: ClientConfig) {
    this.keypair = Keypair.fromSecret(config.secretKey);
    this.horizonServer = new Horizon.Server(
      config.horizonUrl || 'https://horizon-testnet.stellar.org'
    );
    this.sorobanServer = new rpc.Server(
      config.sorobanRpcUrl || 'https://soroban-testnet.stellar.org'
    );
    this.networkPassphrase =
      config.network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  public getPublicKey(): string {
    return this.keypair.publicKey();
  }

  public getKeypair(): Keypair {
    return this.keypair;
  }

  /**
   * Settle an x402 challenge.
   * Automatically routes to Soroban Smart Contract if contractId is present,
   * otherwise executes a classic Stellar payment.
   */
  public async settleChallenge(challenge: ParsedChallenge): Promise<ClientPaymentReceipt> {
    const contractId = challenge.contractId || this.config.contractId;
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

    // Sign transaction with payer keypair
    prepared.sign(this.keypair);

    // Submit transaction to Soroban RPC
    const sendRes = await this.sorobanServer.sendTransaction(prepared);

    if (sendRes.status === 'ERROR') {
      throw new Error(
        `Soroban transaction submission failed: ${JSON.stringify(sendRes.errorResult)}`
      );
    }

    const txHash = sendRes.hash;

    // Poll for ledger inclusion safely using raw _getTransaction (bypassing Protocol 22 parser bug)
    let status: string = sendRes.status;
    let ledger: number | undefined;
    const maxPollAttempts = 30;

    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));

      const rawTx = await (this.sorobanServer as any)._getTransaction(txHash);
      if (rawTx) {
        status = rawTx.status;
        ledger = rawTx.ledger || rawTx.latestLedger;
        if (status === 'SUCCESS') {
          break;
        }
        if (status === 'FAILED') {
          throw new Error(`Soroban settlement transaction failed on-chain: ${txHash}`);
        }
      }
    }

    if (status !== 'SUCCESS') {
      throw new Error(`Soroban transaction timed out waiting for inclusion. Hash: ${txHash}`);
    }

    return {
      txHash,
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

    const result = await this.horizonServer.submitTransaction(transaction);

    return {
      txHash: result.hash,
      challengeId: challenge.challengeId,
      destination: challenge.destination,
      amount: challenge.amount,
      asset: challenge.asset,
      ledger: result.ledger,
      timestamp: Date.now(),
    };
  }
}
