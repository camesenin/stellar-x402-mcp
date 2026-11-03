import { Request, Response, NextFunction } from 'express';
import { GatewayConfig, VerificationResult } from './types.js';
import { ChallengeStore } from './challenge-store.js';
import { StellarPaymentVerifier } from './verifier.js';

export interface X402Request extends Request {
  stellarPayment?: VerificationResult;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, RateLimitBucket>();

  constructor(
    private maxRequests: number = 60,
    private windowMs: number = 60_000,
    private clock: () => number = () => Date.now()
  ) {}

  public isAllowed(clientIp: string): boolean {
    const now = this.clock();
    let bucket = this.buckets.get(clientIp);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 1, resetAt: now + this.windowMs };
      this.buckets.set(clientIp, bucket);
      return true;
    }

    if (bucket.count >= this.maxRequests) {
      return false;
    }

    bucket.count += 1;
    return true;
  }

  public cleanup(): void {
    const now = this.clock();
    for (const [ip, bucket] of this.buckets.entries()) {
      if (now > bucket.resetAt) {
        this.buckets.delete(ip);
      }
    }
  }
}

export function getClientIp(req: Request, trustProxy?: boolean | number | string[]): string {
  const remoteSocketIp = req.socket?.remoteAddress || '127.0.0.1';

  if (!trustProxy) {
    return req.ip || remoteSocketIp;
  }

  const forwarded = req.header('x-forwarded-for');
  if (!forwarded) {
    return req.ip || remoteSocketIp;
  }

  const ips = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
  if (ips.length === 0) return remoteSocketIp;

  if (typeof trustProxy === 'number') {
    // Parse N hops from the right (upstream reverse proxy traversal)
    const index = Math.max(0, ips.length - trustProxy);
    return ips[index] || remoteSocketIp;
  }

  if (Array.isArray(trustProxy)) {
    // Only trust XFF if the immediate upstream socket IP is in the trusted allowlist
    const isImmediateTrusted = trustProxy.includes(remoteSocketIp);
    if (!isImmediateTrusted) {
      return remoteSocketIp;
    }
    // Return rightmost client IP not in the trusted proxy allowlist
    for (let i = ips.length - 1; i >= 0; i--) {
      if (!trustProxy.includes(ips[i])) {
        return ips[i];
      }
    }
  }

  return ips[0] || remoteSocketIp;
}

export function createX402Middleware(
  config: GatewayConfig,
  store: ChallengeStore,
  verifier: StellarPaymentVerifier,
  getRoutePrice?: (req: Request) => { amount: string; asset?: string },
  rateLimiterClock?: () => number
) {
  const rateLimiter = new RateLimiter(60, 60_000, rateLimiterClock);

  return async (req: X402Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Safe IP Determination & Rate Limiting (Anti-DoS)
    const clientIp = getClientIp(req, config.trustProxy);
    if (!rateLimiter.isAllowed(clientIp)) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded for x402 challenge generation. Please retry in 1 minute.',
      });
      return;
    }

    // 2. Extract payment headers
    const txHash =
      (req.header('X-Stellar-TxHash') || req.header('x-stellar-txhash'))?.trim();
    const challengeId =
      (req.header('X-Challenge-Id') || req.header('x-challenge-id') || (req.query.challengeId as string))?.trim();
    const payerSignature =
      (req.header('X-Payer-Signature') || req.header('x-payer-signature'))?.trim();

    // Determine price for this specific resource/route
    const pricing = getRoutePrice
      ? getRoutePrice(req)
      : {
          amount: config.defaultFeeXlm ?? '0.01',
          asset: config.defaultFeeAsset ?? 'XLM',
        };

    const targetAsset = pricing.asset ?? 'XLM';
    const targetAmount = pricing.amount;

    // 3. If txHash and challengeId are present, attempt verification
    if (txHash && challengeId) {
      const challenge = store.getChallenge(challengeId);
      if (!challenge) {
        res.status(402).json({
          error: 'Invalid or expired challenge ID',
          remedy: 'Please request the resource again to obtain a fresh challenge.',
        });
        return;
      }

      // Verify challenge resource binding to prevent cheap-to-expensive resource substitution
      const currentResource = req.originalUrl || req.path;
      if (challenge.resource && currentResource && challenge.resource !== currentResource) {
        res.status(403).json({
          error: 'Challenge Resource Mismatch',
          message: `Challenge '${challengeId}' was issued for resource '${challenge.resource}', but presented for '${currentResource}'.`,
        });
        return;
      }

      // Verify price binding against current route requirement
      if (challenge.amount !== targetAmount || challenge.asset !== targetAsset) {
        res.status(402).json({
          error: 'Challenge Price Mismatch',
          message: `Challenge price (${challenge.amount} ${challenge.asset}) does not match current required payment (${targetAmount} ${targetAsset}).`,
        });
        return;
      }

      // Requester binding defense (anti front-running)
      if (config.requireRequesterAuth && !payerSignature) {
        res.status(401).json({
          error: 'Requester Signature Required',
          message: 'This gateway requires X-Payer-Signature header binding challengeId and txHash.',
        });
        return;
      }

      const gatewayResource = req.originalUrl || req.path || 'default';
      const cleanHash = txHash.trim().toLowerCase();
      const domainMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:${gatewayResource}:${challengeId}:${cleanHash}:${challenge.expiresAt}`;

      const requesterAuth = payerSignature
        ? { message: domainMessage, signatureBase64: payerSignature }
        : undefined;

      const result = await verifier.verifyPayment(txHash, challenge, store, requesterAuth);
      if (!result.valid) {
        if (result.retriable && result.statusCode === 503) {
          res.setHeader('Retry-After', '2');
          res.status(503).json({
            error: 'Payment Verification Temporarily Unavailable',
            details: result.reason,
            txHash,
            challengeId,
            retriable: true,
          });
          return;
        }

        res.status(402).json({
          error: 'Payment verification failed',
          details: result.reason,
          txHash,
          challengeId,
        });
        return;
      }

      // Payment verified! Attach metadata to request and proceed
      req.stellarPayment = result;
      res.setHeader('X-Payment-Settled', 'true');
      res.setHeader('X-Payment-Payer', result.payer ?? '');
      res.setHeader('X-Payment-TxHash', result.txHash ?? '');
      next();
      return;
    }

    // 4. No payment provided: issue 402 challenge with SQLite persistence
    const challenge = store.createChallenge(
      config.destinationPublicKey,
      targetAmount,
      targetAsset,
      req.originalUrl || req.path,
      config.network ?? 'testnet',
      config.contractId,
      config.challengeTtlMs
    );

    res.status(402);
    res.setHeader(
      'WWW-Authenticate',
      `StellarX402 challenge_id="${challenge.challengeId}", destination="${challenge.destination}", amount="${challenge.amount}", asset="${challenge.asset}", memo="${challenge.memo}"`
    );
    res.setHeader('X-Payment-Address', challenge.destination);
    res.setHeader('X-Payment-Amount', challenge.amount);
    res.setHeader('X-Payment-Asset', challenge.asset);
    res.setHeader('X-Payment-Memo', challenge.memo);
    res.setHeader('X-Challenge-Id', challenge.challengeId);
    res.setHeader('X-Payment-Network', challenge.network);
    if (challenge.contractId) {
      res.setHeader('X-Payment-Contract', challenge.contractId);
    }
    if (challenge.tokenAddress) {
      res.setHeader('X-Payment-Token', challenge.tokenAddress);
    }

    res.json({
      status: 402,
      error: 'Payment Required',
      protocol: 'x402-stellar/1.0',
      message: `Access to this resource requires ${challenge.amount} ${challenge.asset} sent to ${challenge.destination} with memo '${challenge.memo}'.`,
      challenge,
    });
  };
}
