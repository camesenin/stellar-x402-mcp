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

export class StellarPaymentVerifier {
  private horizonServer: Horizon.Server;
  private sorobanServer?: rpc.Server;
  private networkPassphrase: string;
  private network: 'testnet' | 'public' | 'custom';
  private sorobanRpcUrl: string;
  private pinnedVaultContractId?: string;

  constructor(
    horizonUrl: string = 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: string = 'https://soroban-testnet.stellar.org',
    network: 'testnet' | 'public' | 'custom' = 'testnet',
    pinnedVaultContractId?: string
  ) {
    this.network = network;
    this.sorobanRpcUrl = sorobanRpcUrl;
    this.pinnedVaultContractId = pinnedVaultContractId;
    this.horizonServer = new Horizon.Server(horizonUrl);
    if (sorobanRpcUrl) {
      this.sorobanServer = new rpc.Server(sorobanRpcUrl);
    }
    this.networkPassphrase =
      network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  /**
   * Fetch transaction from Soroban RPC using official JSON-RPC 2.0 specification
   * completely independent of SDK internal private methods
   */
  public async fetchSorobanTxJsonRpc(txHash: string): Promise<Record<string, any> | null> {
    try {
      const res = await fetch(this.sorobanRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: { hash: txHash },
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      return data?.result || null;
    } catch {
      return null;
    }
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
    store: ChallengeStore,
    requesterAuth?: { payerPublicKey?: string; signatureBase64: string; message: string }
  ): Promise<VerificationResult> {
    const cleanHash = txHash.trim().toLowerCase();

    // 0. Pin check: If gateway configured a pinned vault contract, verify match
    if (this.pinnedVaultContractId && challenge.contractId) {
      if (challenge.contractId !== this.pinnedVaultContractId) {
        return {
          valid: false,
          reason: `Untrusted contract ID: Challenge specifies '${challenge.contractId}', but gateway has pinned '${this.pinnedVaultContractId}'`,
          txHash: cleanHash,
        };
      }
    }

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
      return this.verifySorobanTransactionAndReceipt(cleanHash, challenge, store, requesterAuth);
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
    store: ChallengeStore,
    requesterAuth?: { payerPublicKey?: string; signatureBase64: string; message: string }
  ): Promise<VerificationResult> {
    const targetVault = this.pinnedVaultContractId || challenge.contractId;
    if (!this.sorobanServer || !targetVault) {
      return {
        valid: false,
        reason: 'Soroban RPC server or Contract ID not configured on gateway',
        txHash,
      };
    }

    try {
      // 1. Query transaction status on Soroban RPC using standard JSON-RPC 2.0
      const rawTx = await this.fetchSorobanTxJsonRpc(txHash);

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

      const expectedToken = challenge.tokenAddress || (
        this.network === 'public' ? PUBLIC_NATIVE_SAC : TESTNET_NATIVE_SAC
      );
      const expectedStroops = amountToStroops(challenge.amount);

      // 2. Strict cryptographic and semantic envelope linkage check
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
                  if (invokedContract !== targetVault || fnName !== 'settle_payment') {
                    return false;
                  }

                  const args = invokeArgs.args();
                  if (!args || args.length < 5) {
                    return false;
                  }

                  // 2a. Envelope Recipient binding (arg 1)
                  try {
                    const recipientArg = Address.fromScAddress(args[1].address()).toString();
                    if (recipientArg !== challenge.destination) return false;
                  } catch {
                    return false;
                  }

                  // 2b. Envelope Token SAC binding (arg 2)
                  try {
                    const tokenArg = Address.fromScAddress(args[2].address()).toString();
                    if (tokenArg !== expectedToken) return false;
                  } catch {
                    return false;
                  }

                  // 2c. Envelope Exact Amount in Stroops binding (arg 3)
                  try {
                    const amountNative = scValToNative(args[3]);
                    if (BigInt(amountNative) !== expectedStroops) return false;
                  } catch {
                    return false;
                  }

                  // 2d. Envelope Challenge Hash binding (arg 4)
                  try {
                    const opHash = args[4].bytes();
                    if (!opHash || !opHash.equals(hashBytes)) {
                      return false;
                    }
                  } catch {
                    return false;
                  }

                  return true;
                }
              }
              return false;
            });

            if (!matchingOp) {
              return {
                valid: false,
                reason: `Transaction ${txHash} did not invoke 'settle_payment' for challenge '${challenge.challengeId}' matching exact parameters on target vault ${targetVault}`,
                txHash,
              };
            }
          }
        } catch {
          // If envelope parsing fails, continue to contract storage check
        }
      }

      // 3. Query Soroban contract ledger storage for the persistent receipt
      const receipt = await this.querySorobanContractReceipt(
        targetVault,
        challenge.challengeId
      );

      if (!receipt) {
        return {
          valid: false,
          reason: `No settled payment receipt found in Soroban contract ${targetVault} for challenge ${challenge.challengeId}`,
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

      // 5. Validate SAC Token address matches expected asset
      if (receipt.token !== expectedToken) {
        return {
          valid: false,
          reason: `Receipt token mismatch. Expected '${expectedToken}', found '${receipt.token}'`,
          txHash,
        };
      }

      // 6. Validate exact amount in stroops
      const paidStroops = BigInt(receipt.amount);
      if (paidStroops !== expectedStroops) {
        return {
          valid: false,
          reason: `Amount mismatch: Contract received ${paidStroops} stroops, expected exact ${expectedStroops} stroops`,
          txHash,
        };
      }

      // 7. Requester Binding Defense: If signature proof is present, ensure caller owns payer keypair
      if (requesterAuth) {
        try {
          const { Keypair } = await import('@stellar/stellar-sdk');
          const payerKp = Keypair.fromPublicKey(receipt.payer);
          const isValidSig = payerKp.verify(
            Buffer.from(requesterAuth.message),
            Buffer.from(requesterAuth.signatureBase64, 'base64')
          );
          if (!isValidSig) {
            return {
              valid: false,
              reason: 'Requester authentication failed: Signature does not match on-chain payer keypair',
              txHash,
            };
          }
        } catch (sigErr) {
          return {
            valid: false,
            reason: `Requester signature validation error: ${sigErr}`,
            txHash,
          };
        }
      }

      // 8. Record atomic redemption in SQLite
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
