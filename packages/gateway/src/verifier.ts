import {
  Horizon,
  Networks,
  rpc,
  xdr,
  scValToNative,
  Address,
  Account,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  StrKey,
} from '@stellar/stellar-sdk';
import { X402Challenge, VerificationResult } from './types.js';
import { ChallengeStore } from './challenge-store.js';

interface StellarOpRecord {
  type: string;
  to?: string;
  from?: string;
  source_account?: string;
  funder?: string;
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

export function isTransientInfrastructureError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object' && ((err as any)._isTransientRpcError || (err as any).isTransientInfrastructureError)) {
    return true;
  }

  // 1. Direct status number inspection (status, statusCode, response.status, cause.status, etc.)
  const directStatuses = [
    (err as any)?.statusCode,
    (err as any)?.status,
    (err as any)?.response?.status,
    (err as any)?.cause?.status,
    (err as any)?.cause?.statusCode,
    (err as any)?.cause?.response?.status,
  ];
  for (const s of directStatuses) {
    if (typeof s === 'number' && (s === 429 || (s >= 500 && s <= 599))) {
      return true;
    }
  }

  // 2. Direct code inspection (POSIX, Axios, JSON-RPC, Undici)
  const transientCodes = new Set([
    'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
    'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_BAD_RESPONSE', 'ERR_NETWORK',
    'ECONNABORTED', 'ERR_SOCKET_CONNECTION_TIMEOUT'
  ]);
  const transientRpcCodes = new Set([-32603, -32000, -32001, -32002, -32003, -32004, -32005]);

  const codes = [
    (err as any)?.code,
    (err as any)?.cause?.code,
    (err as any)?.response?.data?.error?.code,
    (err as any)?.data?.error?.code,
  ];
  for (const c of codes) {
    if (c !== undefined && c !== null) {
      if (typeof c === 'string' && transientCodes.has(c.toUpperCase())) return true;
      if (typeof c === 'number' && (transientRpcCodes.has(c) || c === 429 || (c >= 500 && c <= 599))) return true;
    }
  }

  // 3. String representations and message inspection (handling Errors and plain objects defensively)
  const pieces: string[] = [];
  if (err instanceof Error) {
    pieces.push(err.name, err.message);
  } else if (typeof err === 'object') {
    if ((err as any).name) pieces.push(String((err as any).name));
    if ((err as any).message) pieces.push(String((err as any).message));
    if ((err as any).error) {
      if (typeof (err as any).error === 'string') {
        pieces.push((err as any).error);
      } else {
        try {
          pieces.push(JSON.stringify((err as any).error));
        } catch {
          // Circular or unstringifiable error object: capture key names
          try {
            pieces.push(String((err as any).error.message || (err as any).error.code || ''));
          } catch {}
        }
      }
    }
    try { pieces.push(JSON.stringify(err)); } catch {}
  } else {
    pieces.push(String(err));
  }

  const cause = (err as any)?.cause;
  if (cause) {
    if (cause instanceof Error) {
      pieces.push(cause.name, cause.message);
    } else if (typeof cause === 'object') {
      try { pieces.push(JSON.stringify(cause)); } catch {
        try {
          pieces.push(String((cause as any).message || (cause as any).code || ''));
        } catch {}
      }
    } else {
      pieces.push(String(cause));
    }
  }

  const combined = pieces.join(' ').toLowerCase();

  // POSIX / Node network codes
  const codeSubstrings = [
    'eai_again', 'etimedout', 'econnreset', 'econnrefused', 'enotfound',
    'epipe', 'enetunreach', 'ehostunreach', 'enetdown', 'err_bad_response',
    'err_network', 'econnaborted'
  ];
  if (codeSubstrings.some(s => combined.includes(s))) return true;

  // HTTP status codes: 429 and complete 500..599 range
  if (/(^|\D)(429|5\d{2})(\D|$)/.test(combined)) return true;

  // JSON-RPC transient codes (-32603, -32000 to -32005)
  if (/(^|\D)(-32603|-3200[0-5])(\D|$)/.test(combined)) return true;

  // Specific transient terms
  if (/aborterror|timeout|timed out|fetch failed|rate limit|too many requests|overloaded|busy|upstream timeout|gateway timeout|bad gateway|service unavailable/i.test(combined)) {
    return true;
  }

  return false;
}

export class TransientInfrastructureError extends Error {
  public readonly _isTransientRpcError = true;
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 503, public readonly cause?: unknown) {
    super(message);
    this.name = 'TransientInfrastructureError';
    this.statusCode = statusCode;
  }
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

export function stroopsToDecimalString(stroops: bigint): string {
  if (stroops < 0n) {
    throw new Error(`Stroops amount cannot be negative: ${stroops}`);
  }
  const whole = stroops / 10_000_000n;
  const frac = stroops % 10_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
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

  public getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /**
   * Fetch transaction from Soroban RPC using official JSON-RPC 2.0 specification
   * completely independent of SDK internal private methods
   */
  public async fetchSorobanTxJsonRpc(txHash: string): Promise<Record<string, any>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

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
        signal: controller.signal,
      });

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          throw new TransientInfrastructureError(`Soroban RPC HTTP ${res.status} gateway error`, 503);
        }
        throw new Error(`Soroban RPC HTTP error: status ${res.status} ${res.statusText}`);
      }

      let data: any;
      try {
        data = (await res.json()) as any;
      } catch (jsonErr: any) {
        throw new TransientInfrastructureError(
          `Soroban RPC getTransaction returned invalid/truncated JSON: ${jsonErr?.message || jsonErr}`,
          503,
          jsonErr
        );
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new TransientInfrastructureError(
          'Soroban RPC getTransaction returned empty or non-object JSON-RPC response',
          503
        );
      }

      if (data.error) {
        const errObj = data.error;
        if (isTransientInfrastructureError(errObj)) {
          throw new TransientInfrastructureError(
            `Soroban JSON-RPC transient error (${errObj.code}): ${errObj.message || ''}`,
            503,
            errObj
          );
        }
        // If it's another non-transient JSON-RPC error, throw explicit error rather than silently degrading to null
        throw new Error(`Soroban JSON-RPC error (${errObj.code}): ${errObj.message || 'unknown error'}`);
      }

      // getTransaction JSON-RPC contract validation:
      // data.result must be a non-array object with an explicit status enum ('SUCCESS' | 'FAILED' | 'NOT_FOUND')
      if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) {
        throw new TransientInfrastructureError(
          'Soroban RPC getTransaction response missing result object',
          503
        );
      }
      const rawStatus = data.result.status;
      const validStatuses = new Set(['SUCCESS', 'FAILED', 'NOT_FOUND']);
      if (typeof rawStatus !== 'string' || !validStatuses.has(rawStatus)) {
        throw new TransientInfrastructureError(
          `Soroban RPC getTransaction response contains invalid or unknown status enum: '${rawStatus}'. Expected SUCCESS | FAILED | NOT_FOUND`,
          503
        );
      }

      return data.result;
    } catch (err: any) {
      if (err instanceof TransientInfrastructureError) {
        throw err;
      }
      if (isTransientInfrastructureError(err)) {
        throw new TransientInfrastructureError(
          `Soroban RPC getTransaction network timeout/transient failure: ${err?.message || err}`,
          503,
          err
        );
      }
      // Re-throw any non-transient error (e.g. JSON-RPC -32602, HTTP 401, SyntaxError) so caller receives explicit failure
      throw err;
    } finally {
      clearTimeout(timeout);
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
    requesterAuth?: { payerPublicKey?: string; signatureBase64: string; message: string },
    allowGracePeriodMs: number = 0
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

    // 1. Strict challengeId format check: canonical 32-byte CSPRNG nonce in 64 hex characters
    if (!/^[0-9a-fA-F]{64}$/.test(challenge.challengeId)) {
      return {
        valid: false,
        reason: `Malformed challengeId: '${challenge.challengeId}'. Expected strict 64-character hex string representing a 32-byte nonce.`,
        txHash: cleanHash,
      };
    }

    // 2. Anti-Replay SQLite Check (ACID verification)
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

    // Strict Challenge Expiration Defense: reject if challenge is already expired before querying ledger (respecting allowGracePeriodMs up to 60s)
    const numGrace = typeof allowGracePeriodMs === 'number' && !isNaN(allowGracePeriodMs) ? allowGracePeriodMs : 0;
    const effectiveGrace = Math.min(Math.max(0, numGrace), 60_000);
    if (Date.now() > challenge.expiresAt + effectiveGrace) {
      return {
        valid: false,
        reason: `Challenge '${challenge.challengeId}' has expired (expired at ${challenge.expiresAt}, current time ${Date.now()})`,
        txHash: cleanHash,
      };
    }

    // Strict Contextual Binding Defense: If requesterAuth is supplied, verifier reconstructs expected canonical domain message and asserts exact match
    if (requesterAuth) {
      const expectedDomainMessage = `stellar-x402:v1:${this.networkPassphrase}:${challenge.resource}:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      if (requesterAuth.message !== expectedDomainMessage) {
        return {
          valid: false,
          reason: `Requester authentication failed: Domain-separated message mismatch. Expected '${expectedDomainMessage}', presented '${requesterAuth.message}'.`,
          txHash: cleanHash,
        };
      }
    }

      // 2. Branch A: Soroban Contract Verification
      if (challenge.contractId && this.sorobanServer) {
        return this.verifySorobanTransactionAndReceipt(cleanHash, challenge, store, requesterAuth, effectiveGrace);
      }

      // 3. Branch B: Classic Horizon Payment Verification
      return this.verifyHorizonPayment(cleanHash, challenge, store, requesterAuth, effectiveGrace);
  }

  /**
   * Real Soroban on-chain verification querying both getTransaction and getContractData
   */
  private async verifySorobanTransactionAndReceipt(
    txHash: string,
    challenge: X402Challenge,
    store: ChallengeStore,
    requesterAuth?: { payerPublicKey?: string; signatureBase64: string; message: string },
    allowGracePeriodMs: number = 0
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
      let rawTx: Record<string, any>;
      try {
        rawTx = await this.fetchSorobanTxJsonRpc(txHash);
      } catch (fetchErr: any) {
        if (fetchErr instanceof TransientInfrastructureError || isTransientInfrastructureError(fetchErr)) {
          throw fetchErr;
        }
        // Non-transient RPC upstream/protocol errors (e.g. HTTP 401 Unauthorized, JSON-RPC -32602)
        // must be treated as gateway infrastructure failures (502/500), NOT false payment rejections (402)
        throw new TransientInfrastructureError(
          `Soroban RPC upstream query failure: ${fetchErr?.message || fetchErr}`,
          502,
          fetchErr
        );
      }

      if (rawTx.status !== 'SUCCESS') {
        return {
          valid: false,
          reason: `Soroban transaction status is '${rawTx.status}', expected 'SUCCESS'`,
          txHash,
        };
      }

      // 32-byte challenge nonce buffer (strictly validated 64 hex characters)
      const nonceBytes = Buffer.from(challenge.challengeId, 'hex');

      const expectedToken = challenge.tokenAddress || (
        this.network === 'public' ? PUBLIC_NATIVE_SAC : TESTNET_NATIVE_SAC
      );
      const expectedStroops = amountToStroops(challenge.amount);

      let extractedPayer: string | null = null;

      // 2. Strict cryptographic and semantic envelope linkage check
      if (rawTx.envelopeXdr) {
        try {
          const envelope = xdr.TransactionEnvelope.fromXDR(rawTx.envelopeXdr, 'base64');
          let txObj: any = null;
          if (typeof envelope.switch === 'function' && envelope.switch().name === 'envelopeTypeTxFeeBump') {
            const feeBump = envelope.feeBump();
            const innerTx = feeBump.tx().innerTx();
            if (innerTx.switch().name === 'envelopeTypeTx') {
              txObj = innerTx.v1().tx();
            }
          } else {
            const txValue = typeof envelope.value === 'function' ? envelope.value() : envelope;
            if (txValue && 'tx' in txValue) {
              txObj = (txValue as any).tx();
            }
          }
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

                  // 2a. Envelope Payer extraction (arg 0)
                  try {
                    if (typeof args[0].address === 'function') {
                      extractedPayer = Address.fromScAddress(args[0].address()).toString();
                    }
                  } catch {
                    // Optional payer extraction
                  }

                  // 2b. Envelope Recipient binding (arg 1)
                  try {
                    const recipientArg = Address.fromScAddress(args[1].address()).toString();
                    if (recipientArg !== challenge.destination) return false;
                  } catch {
                    return false;
                  }

                  // 2c. Envelope Token SAC binding (arg 2)
                  try {
                    const tokenArg = Address.fromScAddress(args[2].address()).toString();
                    if (tokenArg !== expectedToken) return false;
                  } catch {
                    return false;
                  }

                  // 2d. Envelope Exact Amount in Stroops binding (arg 3)
                  try {
                    const amountNative = scValToNative(args[3]);
                    if (BigInt(amountNative) !== expectedStroops) return false;
                  } catch {
                    return false;
                  }

                  // 2e. Envelope Nonce binding (arg 4)
                  try {
                    const opNonce = args[4].bytes();
                    if (!opNonce || !opNonce.equals(nonceBytes)) {
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
          } else {
            // Fail-closed if transaction envelope operations cannot be parsed
            return {
              valid: false,
              reason: `Malformed or unsupported transaction envelope: unable to parse operations from envelopeXdr`,
              txHash,
            };
          }
        } catch (envelopeErr) {
          return {
            valid: false,
            reason: `Transaction envelope validation failed or malformed: ${envelopeErr}`,
            txHash,
          };
        }
      } else {
        return {
          valid: false,
          reason: `Soroban transaction ${txHash} missing envelopeXdr required for cryptographic parameter verification`,
          txHash,
        };
      }

      // 3. Derive canonical on-chain challenge hash committing to (contract, recipient, token, amount, nonce)
      let onChainHash: Buffer;
      try {
        onChainHash = await this.computeCanonicalChallengeHash(
          targetVault,
          challenge.destination,
          expectedToken,
          expectedStroops,
          nonceBytes
        );
      } catch (simErr: any) {
        return {
          valid: false,
          retriable: true,
          statusCode: 503,
          reason: `Temporary Soroban RPC simulation failure while deriving canonical challenge hash: ${simErr?.message || simErr}. Retry request.`,
          txHash,
        };
      }

      // 4. Query Soroban contract ledger storage for the persistent receipt
      const receipt = await this.querySorobanContractReceipt(
        targetVault,
        onChainHash
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

      // 6b. Defense-in-Depth: Validate payer in operation matches persistent ledger receipt
      if (!extractedPayer || receipt.payer !== extractedPayer) {
        return {
          valid: false,
          reason: `Payer mismatch or unextractable: Envelope invokes payment from '${extractedPayer ?? 'unextractable'}', but ledger receipt records payer '${receipt.payer}'`,
          txHash,
        };
      }

      // 7. Requester Binding Defense: If signature proof is present, ensure caller owns payer keypair
      if (requesterAuth) {
        if (!receipt.payer.startsWith('G')) {
          return {
            valid: false,
            reason: `Direct cryptographic signature verification requires standard ed25519 agent keypair (G...); Smart Contract accounts (${receipt.payer.slice(0, 4)}...) require Soroban on-chain __check_auth`,
            txHash,
          };
        }

        try {
          const { Keypair } = await import('@stellar/stellar-sdk');
          const payerKp = Keypair.fromPublicKey(receipt.payer);
          const isValidSig = payerKp.verify(
            Buffer.from(requesterAuth.message, 'utf-8'),
            Buffer.from(requesterAuth.signatureBase64, 'base64')
          );
          if (!isValidSig) {
            return {
              valid: false,
              reason: 'Requester authentication failed: Domain-separated signature does not match on-chain payer keypair',
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

      // 8. Record atomic redemption in SQLite with fresh expiration check
      try {
        store.markRedeemed(challenge.challengeId, txHash, {
          payer: receipt.payer,
          amount: challenge.amount,
          asset: challenge.asset,
          ledger: rawTx.ledger || rawTx.latestLedger,
        }, allowGracePeriodMs);
      } catch (redeemErr: unknown) {
        const isBusy = (redeemErr as any)?.code === 'SQLITE_BUSY' ||
          (redeemErr instanceof Error && (redeemErr.message.includes('SQLITE_BUSY') || redeemErr.message.includes('database is locked')));
        const errMsg = redeemErr instanceof Error ? redeemErr.message : String(redeemErr);

        if (isBusy) {
          return {
            valid: false,
            retriable: true,
            statusCode: 503,
            reason: `Database busy under writer contention: ${errMsg}. Payment is verified on-chain and unconsumed; please retry verification.`,
            txHash,
          };
        }

        return {
          valid: false,
          reason: `Settlement aborted: ${errMsg}`,
          txHash,
        };
      }

      return {
        valid: true,
        payer: receipt.payer,
        amount: challenge.amount,
        asset: challenge.asset,
        ledger: rawTx.ledger || rawTx.latestLedger,
        txHash,
      };
    } catch (err: unknown) {
      if (err instanceof TransientInfrastructureError || isTransientInfrastructureError(err)) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const statusCode = (err as any)?.statusCode || 503;
        return {
          valid: false,
          retriable: true,
          statusCode,
          reason: `Soroban RPC transient infrastructure failure: ${errorMsg}. Payment verification may be safely retried without double payment.`,
          txHash,
        };
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        reason: `Soroban verification error: ${errorMsg}`,
        txHash,
      };
    }
  }

  /**
   * Deterministically simulate contract function 'compute_challenge_hash' on Soroban RPC.
   * Derives the canonical 32-byte challenge hash on-chain, guaranteeing 100% parity with the contract.
   * Throws an explicit error upon simulation or network failure, allowing caller to return retriable 503.
   */
  public async computeCanonicalChallengeHash(
    contractId: string,
    recipient: string,
    token: string,
    amountStroops: bigint,
    nonceBytes: Buffer
  ): Promise<Buffer> {
    if (!this.sorobanServer) {
      throw new Error('Soroban RPC server not configured for canonical hash simulation');
    }
    const contract = new Contract(contractId);
    const dummyAccount = new Account(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      '0'
    );
    const op = contract.call(
      'compute_challenge_hash',
      new Address(recipient).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(amountStroops, { type: 'i128' }),
      xdr.ScVal.scvBytes(nonceBytes)
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim: any = await this.sorobanServer.simulateTransaction(tx);
    if (sim?.result?.retval) {
      return Buffer.from(sim.result.retval.bytes());
    }
    throw new Error(`Soroban RPC simulation failed to return retval: ${sim?.error || JSON.stringify(sim)}`);
  }

  /**
   * Query Soroban contract ledger storage for DataKey::Receipt(challenge_hash) with defensive schema validation
   */
  public async querySorobanContractReceipt(
    contractId: string,
    canonicalChallengeHash: string | Buffer
  ): Promise<SorobanReceiptRecord | null> {
    if (!this.sorobanServer) {
      throw new TransientInfrastructureError(
        'Soroban RPC server instance not configured on gateway for receipt verification',
        503
      );
    }

    // Create 32-byte canonical challenge hash buffer
    let hashBytes: Buffer;
    if (Buffer.isBuffer(canonicalChallengeHash)) {
      if (canonicalChallengeHash.length !== 32) {
        throw new Error(`Invalid canonicalChallengeHash length: expected 32 bytes, got ${canonicalChallengeHash.length}`);
      }
      hashBytes = canonicalChallengeHash;
    } else if (typeof canonicalChallengeHash === 'string') {
      if (!/^[0-9a-fA-F]{64}$/.test(canonicalChallengeHash)) {
        throw new Error(`Invalid canonicalChallengeHash format: expected 64 hex characters, got '${canonicalChallengeHash}'`);
      }
      hashBytes = Buffer.from(canonicalChallengeHash, 'hex');
    } else {
      throw new Error(`Invalid canonicalChallengeHash type: expected Buffer or hex string, got ${typeof canonicalChallengeHash}`);
    }

    // Match Soroban contract enum DataKey::Receipt(BytesN<32>)
    const keyScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('Receipt'),
      xdr.ScVal.scvBytes(hashBytes),
    ]);

    let data: any;
    try {
      data = await this.sorobanServer.getContractData(
        contractId,
        keyScVal,
        rpc.Durability.Persistent
      );
    } catch (rpcErr: any) {
      if (rpcErr instanceof TransientInfrastructureError) {
        throw rpcErr;
      }
      if (isTransientInfrastructureError(rpcErr)) {
        throw new TransientInfrastructureError(
          `Soroban RPC getContractData transient network failure: ${rpcErr?.message || rpcErr}`,
          503,
          rpcErr
        );
      }
      // Rigorous positive confirmation of entry absence on ledger:
      // @stellar/stellar-sdk getContractData internally inspects getLedgerEntries and rejects with:
      // { code: 404, message: "Contract data not found..." }
      // We demand BOTH code 404 AND positive confirmation in the message that contract data was not found on ledger
      const isDemonstratedAbsence =
        rpcErr?.code === 404 &&
        typeof rpcErr?.message === 'string' &&
        /contract data not found/i.test(rpcErr.message);

      if (isDemonstratedAbsence) {
        return null;
      }

      // If it is neither demonstrated absence nor an expected 404, treat unknown RPC error as transient infrastructure failure
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData non-conclusive query failure: ${rpcErr?.message || rpcErr}`,
        503,
        rpcErr
      );
    }

    if (!data || !data.val) {
      throw new TransientInfrastructureError(
        'Soroban RPC getContractData returned empty or malformed ledger response without entry value',
        503
      );
    }

    let contractData: any;
    try {
      contractData = data.val.contractData();
    } catch (contractDataErr: any) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData failed to parse ledger contractData entry: ${contractDataErr?.message || contractDataErr}`,
        503,
        contractDataErr
      );
    }

    let native: unknown;
    try {
      native = scValToNative(contractData.val());
    } catch (deserErr: any) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData failed to deserialize receipt ScVal: ${deserErr?.message || deserErr}`,
        503,
        deserErr
      );
    }

    // Strict defensive schema validation of the deserialized receipt struct
    if (!native || typeof native !== 'object') {
      throw new TransientInfrastructureError(
        'Soroban RPC getContractData deserialized receipt is not a valid struct object',
        503
      );
    }

    const rec = native as Record<string, unknown>;
    if (
      typeof rec.payer !== 'string' ||
      typeof rec.recipient !== 'string' ||
      typeof rec.token !== 'string' ||
      rec.amount === undefined ||
      rec.amount === null ||
      rec.timestamp === undefined ||
      rec.timestamp === null
    ) {
      throw new TransientInfrastructureError(
        'Soroban RPC getContractData deserialized receipt lacks required fields (payer, recipient, token, amount, timestamp)',
        503
      );
    }

    // Defensive parsing & validation of addresses using official Stellar StrKey cryptographic format
    const isValidPayer =
      StrKey.isValidEd25519PublicKey(rec.payer) || StrKey.isValidContract(rec.payer);
    if (!isValidPayer) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData invalid receipt payer address format: '${rec.payer}'`,
        503
      );
    }
    const isValidRecipient =
      StrKey.isValidEd25519PublicKey(rec.recipient) || StrKey.isValidContract(rec.recipient);
    if (!isValidRecipient) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData invalid receipt recipient address format: '${rec.recipient}'`,
        503
      );
    }
    if (!StrKey.isValidContract(rec.token)) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData invalid receipt token address format: '${rec.token}'`,
        503
      );
    }

    // Defensive parsing & validation of amount (must be positive BigInt in u128/i128 domain)
    let parsedAmount: bigint;
    try {
      if (typeof rec.amount === 'bigint') {
        parsedAmount = rec.amount;
      } else if (typeof rec.amount === 'number') {
        if (!Number.isSafeInteger(rec.amount) || rec.amount <= 0) {
          throw new Error(`Amount number out of range: ${rec.amount}`);
        }
        parsedAmount = BigInt(rec.amount);
      } else if (typeof rec.amount === 'string' && /^\d+$/.test(rec.amount)) {
        parsedAmount = BigInt(rec.amount);
      } else {
        throw new Error(`Unsupported amount representation: ${rec.amount}`);
      }
      if (parsedAmount <= 0n) {
        throw new Error(`Non-positive amount: ${parsedAmount}`);
      }
    } catch (amountErr: any) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData malformed or unconvertible receipt amount: ${amountErr?.message || amountErr}`,
        503,
        amountErr
      );
    }

    // Defensive parsing & validation of timestamp: strictly positive integer in Soroban u64 domain (1 to 2^64 - 1)
    const MAX_U64 = 18446744073709551615n;
    let parsedTimestamp: bigint;
    try {
      if (typeof rec.timestamp === 'bigint') {
        parsedTimestamp = rec.timestamp;
      } else if (typeof rec.timestamp === 'number') {
        if (!Number.isSafeInteger(rec.timestamp) || rec.timestamp <= 0) {
          throw new Error(`Timestamp out of range: ${rec.timestamp}`);
        }
        parsedTimestamp = BigInt(rec.timestamp);
      } else if (typeof rec.timestamp === 'string' && /^\d+$/.test(rec.timestamp)) {
        parsedTimestamp = BigInt(rec.timestamp);
      } else {
        throw new Error(`Unsupported timestamp representation: ${rec.timestamp}`);
      }
      if (parsedTimestamp <= 0n || parsedTimestamp > MAX_U64) {
        throw new Error(`Timestamp outside valid positive u64 range: ${parsedTimestamp}`);
      }
    } catch (tsErr: any) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData malformed or unconvertible receipt timestamp: ${tsErr?.message || tsErr}`,
        503,
        tsErr
      );
    }

    // Defensive parsing & validation of challenge_hash in persistent receipt:
    // Must match the requested canonical challenge hash byte-for-byte
    let storedHashBytes: Buffer;
    if (Buffer.isBuffer(rec.challenge_hash)) {
      storedHashBytes = rec.challenge_hash;
    } else if (typeof rec.challenge_hash === 'string' && /^[0-9a-fA-F]{64}$/.test(rec.challenge_hash)) {
      storedHashBytes = Buffer.from(rec.challenge_hash, 'hex');
    } else if (rec.challenge_hash instanceof Uint8Array && rec.challenge_hash.length === 32) {
      storedHashBytes = Buffer.from(rec.challenge_hash);
    } else {
      throw new TransientInfrastructureError(
        'Soroban RPC getContractData receipt contains invalid or missing challenge_hash',
        503
      );
    }

    if (!storedHashBytes.equals(hashBytes)) {
      throw new TransientInfrastructureError(
        `Soroban RPC getContractData receipt challenge_hash mismatch: expected ${hashBytes.toString('hex')}, found ${storedHashBytes.toString('hex')}`,
        503
      );
    }

    return {
      payer: rec.payer,
      recipient: rec.recipient,
      token: rec.token,
      amount: parsedAmount,
      timestamp: parsedTimestamp,
      challenge_hash: storedHashBytes,
    };
  }

  /**
   * Classic Horizon payment verification
   */
  private async verifyHorizonPayment(
    cleanHash: string,
    challenge: X402Challenge,
    store: ChallengeStore,
    requesterAuth?: { payerPublicKey?: string; signatureBase64: string; message: string },
    allowGracePeriodMs: number = 0
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

      // Verify Operations (with full pagination across all pages)
      let opsPage = await tx.operations();
      const contributingPayers = new Set<string>();
      let matchedAsset = '';

      // Strict integer stroop parsing using canonical amountToStroops (1 XLM/unit = 10,000,000 stroops)
      const expectedStroops = amountToStroops(challenge.amount);
      let paidStroops = 0n;

      while (opsPage && opsPage.records) {
        for (const op of opsPage.records as unknown as StellarOpRecord[]) {
          if (op.type === 'payment') {
            const isNative =
              challenge.asset.toUpperCase() === 'XLM' ||
              challenge.asset.toUpperCase() === 'NATIVE';
            const opIsNative = op.asset_type === 'native';

            if (op.to === challenge.destination) {
              if (isNative && opIsNative) {
                paidStroops += amountToStroops(op.amount || '0');
                matchedAsset = 'XLM';
                const effectivePayer = op.source_account || op.from || tx.source_account;
                contributingPayers.add(effectivePayer);
              } else if (!isNative && !opIsNative) {
                const fullAsset = `${op.asset_code}:${op.asset_issuer}`;
                if (fullAsset === challenge.asset) {
                  paidStroops += amountToStroops(op.amount || '0');
                  matchedAsset = fullAsset;
                  const effectivePayer = op.source_account || op.from || tx.source_account;
                  contributingPayers.add(effectivePayer);
                }
              }
            }
          } else if (op.type === 'create_account') {
            // create_account in Stellar is strictly native XLM
            const isNative =
              challenge.asset.toUpperCase() === 'XLM' ||
              challenge.asset.toUpperCase() === 'NATIVE';
            if (isNative && op.account === challenge.destination) {
              paidStroops += amountToStroops(op.starting_balance || '0');
              matchedAsset = 'XLM';
              const effectivePayer = op.source_account || op.funder || tx.source_account;
              contributingPayers.add(effectivePayer);
            }
          }
        }

        // Fetch next page of operations if present
        if (typeof opsPage.next === 'function' && opsPage.records.length > 0) {
          const nextPage = await opsPage.next();
          if (nextPage && nextPage.records && nextPage.records.length > 0) {
            opsPage = nextPage;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      const formattedPaid = stroopsToDecimalString(paidStroops);
      const paymentFound = paidStroops >= expectedStroops && paidStroops > 0n;

      if (!paymentFound) {
        return {
          valid: false,
          reason: `Payment requirements not met. Found ${formattedPaid} ${matchedAsset || challenge.asset}, required >= ${challenge.amount} ${challenge.asset} to ${challenge.destination}`,
          txHash: cleanHash,
        };
      }

      // Disallow multi-payer ambiguity: payment operations must originate from exactly one effective payer account
      if (contributingPayers.size !== 1) {
        return {
          valid: false,
          reason: `Payment rejected: multiple or ambiguous operation payers detected (${contributingPayers.size} payers). Expected single accountable payer.`,
          txHash: cleanHash,
        };
      }

      const payerAddress = Array.from(contributingPayers)[0];

      // Requester Binding Defense: If signature proof is present, ensure caller owns payer keypair
      if (requesterAuth) {
        if (!payerAddress.startsWith('G')) {
          return {
            valid: false,
            reason: `Direct cryptographic signature verification requires standard ed25519 agent keypair (G...); received ${payerAddress}`,
            txHash: cleanHash,
          };
        }

        try {
          const { Keypair } = await import('@stellar/stellar-sdk');
          const payerKp = Keypair.fromPublicKey(payerAddress);
          const isValidSig = payerKp.verify(
            Buffer.from(requesterAuth.message, 'utf-8'),
            Buffer.from(requesterAuth.signatureBase64, 'base64')
          );
          if (!isValidSig) {
            return {
              valid: false,
              reason: 'Requester authentication failed: Domain-separated signature does not match on-chain payer keypair',
              txHash: cleanHash,
            };
          }
        } catch (sigErr) {
          return {
            valid: false,
            reason: `Requester signature validation error: ${sigErr}`,
            txHash: cleanHash,
          };
        }
      }

      // Mark as redeemed in SQLite with atomic lock & fresh expiration check
      try {
        store.markRedeemed(challenge.challengeId, cleanHash, {
          payer: payerAddress,
          amount: formattedPaid,
          asset: matchedAsset || challenge.asset,
          ledger: tx.ledger_attr,
        }, allowGracePeriodMs);
      } catch (redeemErr: unknown) {
        const isBusy = (redeemErr as any)?.code === 'SQLITE_BUSY' ||
          (redeemErr instanceof Error && (redeemErr.message.includes('SQLITE_BUSY') || redeemErr.message.includes('database is locked')));
        const errMsg = redeemErr instanceof Error ? redeemErr.message : String(redeemErr);

        if (isBusy) {
          return {
            valid: false,
            retriable: true,
            statusCode: 503,
            reason: `Database busy under writer contention: ${errMsg}. Payment is verified on-chain and unconsumed; please retry verification.`,
            txHash: cleanHash,
          };
        }

        return {
          valid: false,
          reason: `Settlement aborted: ${errMsg}`,
          txHash: cleanHash,
        };
      }

      return {
        valid: true,
        payer: payerAddress,
        amount: formattedPaid,
        asset: matchedAsset || challenge.asset,
        ledger: tx.ledger_attr,
        txHash: cleanHash,
      };
    } catch (err: unknown) {
      if (err instanceof TransientInfrastructureError || isTransientInfrastructureError(err)) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const rawStatus = (err as any)?.statusCode || (err as any)?.response?.status;
        const statusCode = typeof rawStatus === 'number' && rawStatus >= 500 && rawStatus <= 599 ? rawStatus : 503;
        return {
          valid: false,
          retriable: true,
          statusCode,
          reason: `Stellar Horizon transient infrastructure failure: ${errorMsg}. Payment verification may be safely retried without double payment.`,
          txHash: cleanHash,
        };
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        reason: `Failed to verify transaction on Stellar ledger: ${errorMsg}`,
        txHash: cleanHash,
      };
    }
  }
}
