import { Request, Response, NextFunction } from 'express';
import { GatewayConfig, VerificationResult } from './types.js';
import { ChallengeStore } from './challenge-store.js';
import { StellarPaymentVerifier } from './verifier.js';

export interface X402Request extends Request {
  stellarPayment?: VerificationResult;
}

export function createX402Middleware(
  config: GatewayConfig,
  store: ChallengeStore,
  verifier: StellarPaymentVerifier,
  getRoutePrice?: (req: Request) => { amount: string; asset?: string }
) {
  return async (req: X402Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Extract payment headers
    const txHash =
      (req.header('X-Stellar-TxHash') || req.header('x-stellar-txhash'))?.trim();
    const challengeId =
      (req.header('X-Challenge-Id') || req.header('x-challenge-id') || (req.query.challengeId as string))?.trim();

    // Determine price for this specific resource/route
    const pricing = getRoutePrice
      ? getRoutePrice(req)
      : {
          amount: config.defaultFeeXlm ?? '0.01',
          asset: config.defaultFeeAsset ?? 'XLM',
        };

    const targetAsset = pricing.asset ?? 'XLM';
    const targetAmount = pricing.amount;

    // 2. If txHash and challengeId are present, attempt verification
    if (txHash && challengeId) {
      const challenge = store.getChallenge(challengeId);
      if (!challenge) {
        res.status(402).json({
          error: 'Invalid or expired challenge ID',
          remedy: 'Please request the resource again to obtain a fresh challenge.',
        });
        return;
      }

      const result = await verifier.verifyPayment(txHash, challenge, store);
      if (!result.valid) {
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

    // 3. No payment provided: issue 402 challenge
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

    res.json({
      status: 402,
      error: 'Payment Required',
      protocol: 'x402-stellar/1.0',
      message: `Access to this resource requires ${challenge.amount} ${challenge.asset} sent to ${challenge.destination} with memo '${challenge.memo}'.`,
      challenge,
    });
  };
}
