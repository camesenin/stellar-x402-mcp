import {
  Horizon,
  Networks,
  rpc,
  xdr,
  scValToNative,
  Address,
} from '@stellar/stellar-sdk';
import { X402Challenge, VerificationResult } from './types.js';
import { ChallengeStore } from './challenge-store.js';

interface StellarOpRecord {
  type: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  account?: string;
  starting_balance?: string;
}

export interface SorobanReceiptRecord {
  payer: string;
  recipient: string;
  token: string;
  amount: bigint | number | string;
  timestamp: number | bigint;
  challenge_hash: Buffer | Uint8Array;
}

const TESTNET_NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PUBLIC_NATIVE_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

export function amountToStroops(amount: string | number): bigint {
  const str = String(amount).trim();
  if (str.includes('.')) {
    const parts = str.split('.');
    const whole = parts[0] || '0';
    const fraction = (parts[1] || '').padEnd(7, '0').slice(0, 7);
    return BigInt(whole) * 10_000_000n + BigInt(fraction);
  }
  return BigInt(str) * 10_000_000n;
}

export class StellarPaymentVerifier {
  private horizonServer: Horizon.Server;
  private sorobanServer?: rpc.Server;
  private networkPassphrase: string;
  private network: 'testnet' | 'public' | 'custom';

  constructor(
    horizonUrl: string = 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: string = 'https://soroban-testnet.stellar.org',
    network: 'testnet' | 'public' | 'custom' = 'testnet'
  ) {
    this.network = network;
    this.horizonServer = new Horizon.Server(horizonUrl);
    if (sorobanRpcUrl) {
      this.sorobanServer = new rpc.Server(sorobanRpcUrl);
    }
    this.networkPassphrase =
      network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  /**
   * Verify an on-chain transaction against an x402 challenge.
   * Supports both:
   * 1. Soroban Smart Contract settlements via Soroban RPC
   * 2. Stellar Horizon Classic Payments with anti-replay memo verification
   */
  public async verifyPayment(
    txHash: string,
    challenge: X402Challenge,
    store: ChallengeStore
  ): Promise<VerificationResult> {
    const cleanHash = txHash.trim().toLowerCase();

    // 1. Anti-Replay SQLite Check (ACID verification)
    if (store.isTxRedeemed(cleanHash)) {
      return {
        valid: false,
        reason: 'Transaction hash has already been redeemed (replay attack prevented)',
        txHash: cleanHash,
      };
    }

    if (store.isChallengeRedeemed(challenge.challengeId)) {
      return {
        valid: false,
        reason: 'Challenge has already been settled previously',
        txHash: cleanHash,
      };
    }

    // 2. Branch A: Soroban Contract Verification
    if (challenge.contractId && this.sorobanServer) {
      return this.verifySorobanTransactionAndReceipt(cleanHash, challenge, store);
    }

    // 3. Branch B: Classic Horizon Payment Verification
    return this.verifyHorizonPayment(cleanHash, challenge, store);
  }

  /**
   * Real Soroban on-chain verification querying both getTransaction and getContractData
   */
  private async verifySorobanTransactionAndReceipt(
    txHash: string,
    challenge: X402Challenge,
    store: ChallengeStore
  ): Promise<VerificationResult> {
    if (!this.sorobanServer || !challenge.contractId) {
      return {
        valid: false,
        reason: 'Soroban RPC server or Contract ID not configured on gateway',
        txHash,
      };
    }

    try {
      // 1. Query transaction status on Soroban RPC using safe raw fetch (bypassing Protocol 22 Bad union switch: 4 bug)
      const rawTx = await (this.sorobanServer as any)._getTransaction(txHash);

      if (!rawTx || rawTx.status !== 'SUCCESS') {
        return {
          valid: false,
          reason: `Soroban transaction status is '${rawTx?.status || 'NOT_FOUND'}', expected 'SUCCESS'`,
          txHash,
        };
      }

      // Compute expected 32-byte challenge hash buffer
      let hashBytes: Buffer;
      if (challenge.challengeId.length === 64) {
        hashBytes = Buffer.from(challenge.challengeId, 'hex');
      } else {
        const crypto = await import('node:crypto');
        hashBytes = crypto.createHash('sha256').update(challenge.challengeId).digest();
      }

      // 2. Cryptographic and semantic envelope linkage check
      if (rawTx.envelopeXdr) {
        try {
          const envelope = xdr.TransactionEnvelope.fromXDR(rawTx.envelopeXdr, 'base64');
          const txValue = envelope.value();
          const txObj = 'tx' in txValue ? (txValue as any).tx() : null;
          if (txObj) {
            const ops = txObj.operations();
            const matchingOp = ops.find((op: any) => {
              const body = op.body();
              if (body.switch().name === 'invokeHostFunction') {
                const hostFn = body.invokeHostFunctionOp().hostFunction();
                if (hostFn.switch().name === 'hostFunctionTypeInvokeContract') {
                  const invokeArgs = hostFn.invokeContract();
                  const invokedContract = Address.fromScAddress(invokeArgs.contractAddress()).toString();
                  const fnName = invokeArgs.functionName().toString();
                  return invokedContract === challenge.contractId && fnName === 'settle_payment';
                }
              }
              return false;
            });

            if (!matchingOp) {
              return {
                valid: false,
                reason: `Transaction ${txHash} did not invoke 'settle_payment' on target contract ${challenge.contractId}`,
                txHash,
              };
            }
          }
        } catch {
          // If envelope parsing has an issue, fallback to ledger storage receipt check
        }
      }

      // 3. Query Soroban contract ledger storage for the persistent receipt
      const receipt = await this.querySorobanContractReceipt(
        challenge.contractId,
        challenge.challengeId
      );

      if (!receipt) {
        return {
          valid: false,
          reason: `No settled payment receipt found in Soroban contract ${challenge.contractId} for challenge ${challenge.challengeId}`,
          txHash,
        };
      }

      // 4. Validate recipient address matches challenge destination
      if (receipt.recipient !== challenge.destination) {
        return {
          valid: false,
          reason: `Receipt recipient mismatch. Expected '${challenge.destination}', found '${receipt.recipient}'`,
          txHash,
        };
      }

      // 5. Validate SAC Token address matches expected asset (prevents paying with fake tokens)
      const expectedToken = challenge.tokenAddress || (
        this.network === 'public' ? PUBLIC_NATIVE_SAC : TESTNET_NATIVE_SAC
      );
      if (receipt.token !== expectedToken) {
        return {
          valid: false,
          reason: `Receipt token mismatch. Expected '${expectedToken}', found '${receipt.token}'`,
          txHash,
        };
      }

      // 6. Validate exact amount in stroops (eliminates overpayment/underpayment discrepancies)
      const expectedStroops = amountToStroops(challenge.amount);
      const paidStroops = BigInt(receipt.amount);
      if (paidStroops !== expectedStroops) {
        return {
          valid: false,
          reason: `Amount mismatch: Contract received ${paidStroops} stroops, expected exact ${expectedStroops} stroops`,
          txHash,
        };
      }

      // 7. Record atomic redemption in SQLite
      store.markRedeemed(challenge.challengeId, txHash, {
        payer: receipt.payer,
        amount: challenge.amount,
        asset: challenge.asset,
        ledger: rawTx.ledger || rawTx.latestLedger,
      });

      return {
        valid: true,
        payer: receipt.payer,
        amount: challenge.amount,
        asset: challenge.asset,
        ledger: rawTx.ledger || rawTx.latestLedger,
        txHash,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        reason: `Soroban verification error: ${errorMsg}`,
        txHash,
      };
    }
  }

  /**
   * Query Soroban contract ledger storage for DataKey::Receipt(challenge_hash) with defensive schema validation
   */
  public async querySorobanContractReceipt(
    contractId: string,
    challengeId: string
  ): Promise<SorobanReceiptRecord | null> {
    if (!this.sorobanServer) return null;

    try {
      // Create 32-byte challenge hash buffer
      let hashBytes: Buffer;
      if (challengeId.length === 64) {
        hashBytes = Buffer.from(challengeId, 'hex');
      } else {
        const crypto = await import('node:crypto');
        hashBytes = crypto.createHash('sha256').update(challengeId).digest();
      }

      // Match Soroban contract enum DataKey::Receipt(BytesN<32>)
      const keyScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Receipt'),
        xdr.ScVal.scvBytes(hashBytes),
      ]);

      const data = await this.sorobanServer.getContractData(
        contractId,
        keyScVal,
        rpc.Durability.Persistent
      );

      if (!data || !data.val) {
        return null;
      }

      const contractData = data.val.contractData();
      let native: unknown;
      try {
        native = scValToNative(contractData.val());
      } catch {
        return null;
      }

      // Strict defensive schema validation of the deserialized receipt struct
      if (!native || typeof native !== 'object') {
        return null;
      }

      const rec = native as Record<string, unknown>;
      if (
        typeof rec.payer !== 'string' ||
        typeof rec.recipient !== 'string' ||
        typeof rec.token !== 'string' ||
        rec.amount === undefined ||
        rec.timestamp === undefined
      ) {
        return null;
      }

      return {
        payer: rec.payer,
        recipient: rec.recipient,
        token: rec.token,
        amount: rec.amount as bigint | number | string,
        timestamp: rec.timestamp as number | bigint,
        challenge_hash: hashBytes,
      };
    } catch {
      return null;
    }
  }

  /**
   * Classic Horizon payment verification
   */
  private async verifyHorizonPayment(
    cleanHash: string,
    challenge: X402Challenge,
    store: ChallengeStore
  ): Promise<VerificationResult> {
    try {
      const tx = await this.horizonServer.transactions().transaction(cleanHash).call();

      if (!tx.successful) {
        return {
          valid: false,
          reason: 'Transaction execution failed on-chain',
          txHash: cleanHash,
        };
      }

      // Verify Memo (strict equality with challengeId or challenge.memo)
      const txMemo = tx.memo?.toString() || '';
      if (txMemo !== challenge.memo && txMemo !== challenge.challengeId) {
        return {
          valid: false,
          reason: `Memo mismatch. Expected '${challenge.memo}', found '${txMemo}'`,
          txHash: cleanHash,
        };
      }

      // Verify Operations
      const ops = await tx.operations();
      let paymentFound = false;
      let paidAmount = 0;
      let payerAddress = tx.source_account;
      let matchedAsset = '';

      const expectedAmount = parseFloat(challenge.amount);

      for (const op of ops.records as unknown as StellarOpRecord[]) {
        if (op.type === 'payment') {
          const isNative =
            challenge.asset.toUpperCase() === 'XLM' ||
            challenge.asset.toUpperCase() === 'NATIVE';
          const opIsNative = op.asset_type === 'native';

          if (op.to === challenge.destination) {
            if (isNative && opIsNative) {
              const amt = parseFloat(op.amount || '0');
              paidAmount += amt;
              matchedAsset = 'XLM';
              if (paidAmount >= expectedAmount) {
                paymentFound = true;
                break;
              }
            } else if (!isNative && !opIsNative) {
              const fullAsset = `${op.asset_code}:${op.asset_issuer}`;
              if (fullAsset === challenge.asset) {
                const amt = parseFloat(op.amount || '0');
                paidAmount += amt;
                matchedAsset = fullAsset;
                if (paidAmount >= expectedAmount) {
                  paymentFound = true;
                  break;
                }
              }
            }
          }
        } else if (op.type === 'create_account') {
          if (op.account === challenge.destination) {
            const amt = parseFloat(op.starting_balance || '0');
            paidAmount += amt;
            matchedAsset = 'XLM';
            if (paidAmount >= expectedAmount) {
              paymentFound = true;
              break;
            }
          }
        }
      }

      if (!paymentFound) {
        return {
          valid: false,
          reason: `Payment requirements not met. Found ${paidAmount} ${matchedAsset || challenge.asset}, required >= ${expectedAmount} ${challenge.asset} to ${challenge.destination}`,
          txHash: cleanHash,
        };
      }

      // Mark as redeemed in SQLite
      store.markRedeemed(challenge.challengeId, cleanHash, {
        payer: payerAddress,
        amount: paidAmount.toString(),
        asset: matchedAsset || challenge.asset,
        ledger: tx.ledger_attr,
      });

      return {
        valid: true,
        payer: payerAddress,
        amount: paidAmount.toString(),
        asset: matchedAsset || challenge.asset,
        ledger: tx.ledger_attr,
        txHash: cleanHash,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        reason: `Failed to verify transaction on Stellar ledger: ${errorMsg}`,
        txHash: cleanHash,
      };
    }
  }
}
