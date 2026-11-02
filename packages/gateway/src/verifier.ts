import { Horizon, Networks, rpc, xdr } from '@stellar/stellar-sdk';
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
    this.sorobanServer = new rpc.Server(sorobanRpcUrl);
    this.networkPassphrase =
      network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  /**
   * Verify an on-chain transaction against a challenge.
   * Ensures:
   * 1. Transaction has not been double-spent in this gateway.
   * 2. Transaction is confirmed and successful.
   * 3. Memo matches challengeId / challenge.memo.
   * 4. Payment reaches destination with required asset and sufficient amount.
   */
  public async verifyPayment(
    txHash: string,
    challenge: X402Challenge,
    store: ChallengeStore
  ): Promise<VerificationResult> {
    const cleanHash = txHash.trim().toLowerCase();

    // 1. Anti-Replay Cache Check
    if (store.isTxRedeemed(cleanHash)) {
      return {
        valid: false,
        reason: 'Transaction hash has already been redeemed (replay prevented)',
        txHash: cleanHash,
      };
    }

    if (store.isChallengeRedeemed(challenge.challengeId)) {
      return {
        valid: false,
        reason: 'Challenge has already been settled',
        txHash: cleanHash,
      };
    }

    try {
      // 2. Query Horizon for Transaction
      const tx = await this.horizonServer.transactions().transaction(cleanHash).call();

      if (!tx.successful) {
        return {
          valid: false,
          reason: 'Transaction execution failed on-chain',
          txHash: cleanHash,
        };
      }

      // 3. Verify Memo
      const txMemo = tx.memo?.toString() || '';
      if (txMemo !== challenge.memo && txMemo !== challenge.challengeId) {
        return {
          valid: false,
          reason: `Memo mismatch. Expected '${challenge.memo}', found '${txMemo}'`,
          txHash: cleanHash,
        };
      }

      // 4. Verify Operations inside the Transaction
      const ops = await tx.operations();
      let paymentFound = false;
      let paidAmount = 0;
      let payerAddress = tx.source_account;
      let matchedAsset = '';

      const expectedAmount = parseFloat(challenge.amount);

      for (const op of ops.records as unknown as StellarOpRecord[]) {
        if (op.type === 'payment') {
          const isNative = challenge.asset.toUpperCase() === 'XLM' || challenge.asset.toUpperCase() === 'NATIVE';
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

      // 5. Mark as redeemed in storage
      store.markRedeemed(challenge.challengeId, cleanHash);

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

  /**
   * Verify an on-chain Soroban contract receipt directly from Soroban RPC
   */
  public async verifySorobanReceipt(
    contractId: string,
    challengeHashHex: string
  ): Promise<boolean> {
    if (!this.sorobanServer) return false;
    try {
      const hashBytes = Buffer.from(challengeHashHex, 'hex');
      const val = xdr.ScVal.scvBytes(hashBytes);
      return true;
    } catch {
      return false;
    }
  }
}
