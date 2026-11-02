import {
  Horizon,
  Networks,
  rpc,
  xdr,
  scValToNative,
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

export class StellarPaymentVerifier {
  private horizonServer: Horizon.Server;
  private sorobanServer?: rpc.Server;
  private networkPassphrase: string;

  constructor(
    horizonUrl: string = 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: string = 'https://soroban-testnet.stellar.org',
    network: 'testnet' | 'public' | 'custom' = 'testnet'
  ) {
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
      // 1. Query transaction status on Soroban RPC
      const tx = await this.sorobanServer.getTransaction(txHash);

      if (tx.status !== 'SUCCESS') {
        return {
          valid: false,
          reason: `Soroban transaction status is '${tx.status}', expected 'SUCCESS'`,
          txHash,
        };
      }

      // 2. Query Soroban contract ledger storage for the receipt
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

      // 3. Validate receipt contents against challenge requirements
      if (receipt.recipient !== challenge.destination) {
        return {
          valid: false,
          reason: `Receipt recipient mismatch. Expected '${challenge.destination}', found '${receipt.recipient}'`,
          txHash,
        };
      }

      const paidAmount = Number(receipt.amount);
      const expectedAmount = parseFloat(challenge.amount);
      if (paidAmount < expectedAmount) {
        return {
          valid: false,
          reason: `Underpaid: Contract received ${paidAmount}, required >= ${expectedAmount}`,
          txHash,
        };
      }

      // 4. Record redemption in SQLite
      store.markRedeemed(challenge.challengeId, txHash, {
        payer: receipt.payer,
        amount: paidAmount.toString(),
        asset: challenge.asset,
        ledger: tx.latestLedger,
      });

      return {
        valid: true,
        payer: receipt.payer,
        amount: paidAmount.toString(),
        asset: challenge.asset,
        ledger: tx.latestLedger,
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
   * Query Soroban contract ledger storage for DataKey::Receipt(challenge_hash)
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
      const native = scValToNative(contractData.val()) as Record<string, unknown>;
      return {
        payer: String(native.payer),
        recipient: String(native.recipient),
        token: String(native.token),
        amount: native.amount as bigint | number | string,
        timestamp: native.timestamp as number | bigint,
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
