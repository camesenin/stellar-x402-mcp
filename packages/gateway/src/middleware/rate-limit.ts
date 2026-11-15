import { Request, Response, NextFunction } from 'express';

export interface TokenBucketOptions {
  capacity?: number;
  refillRatePerSecond?: number;
  clock?: () => number;
  keyGenerator?: (req: Request) => string;
}

export interface TokenBucketConsumeResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetEpochSeconds: number;
  retryAfterSeconds: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const STRKEY_HEADER_CANDIDATES = [
  'x-stellar-account',
  'x-payer-address',
  'x-stellar-address',
];

export function defaultRateLimitKey(req: Request): string {
  for (const header of STRKEY_HEADER_CANDIDATES) {
    const val = req.header(header)?.trim();
    if (val && /^[GC][A-Z2-7]{55}$/.test(val)) {
      return `strkey:${val}`;
    }
  }
  const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  return `ip:${ip}`;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly capacity: number;
  private readonly refillRatePerSecond: number;
  private readonly clock: () => number;

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 60);
    this.refillRatePerSecond = Math.max(0.001, options.refillRatePerSecond ?? 1);
    this.clock = options.clock ?? (() => Date.now());
  }

  public consume(key: string, cost: number = 1): TokenBucketConsumeResult {
    const nowMs = this.clock();
    let state = this.buckets.get(key);

    if (!state) {
      state = {
        tokens: this.capacity,
        lastRefillMs: nowMs,
      };
    } else {
      const elapsedSeconds = Math.max(0, (nowMs - state.lastRefillMs) / 1000);
      if (elapsedSeconds > 0) {
        state.tokens = Math.min(
          this.capacity,
          state.tokens + elapsedSeconds * this.refillRatePerSecond
        );
        state.lastRefillMs = nowMs;
      }
    }

    if (state.tokens >= cost) {
      state.tokens -= cost;
      this.buckets.set(key, state);
      const remaining = Math.floor(state.tokens);
      const deficitToFull = Math.max(0, this.capacity - state.tokens);
      const secondsToFull = Math.ceil(deficitToFull / this.refillRatePerSecond);
      return {
        allowed: true,
        limit: this.capacity,
        remaining,
        resetEpochSeconds: Math.ceil(nowMs / 1000) + secondsToFull,
        retryAfterSeconds: 0,
      };
    }

    this.buckets.set(key, state);
    const needed = cost - state.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(needed / this.refillRatePerSecond));
    const deficitToFull = Math.max(0, this.capacity - state.tokens);
    const secondsToFull = Math.ceil(deficitToFull / this.refillRatePerSecond);

    return {
      allowed: false,
      limit: this.capacity,
      remaining: 0,
      resetEpochSeconds: Math.ceil(nowMs / 1000) + secondsToFull,
      retryAfterSeconds,
    };
  }

  public cleanup(maxIdleMs: number = 300_000): void {
    const nowMs = this.clock();
    for (const [key, state] of this.buckets.entries()) {
      if (nowMs - state.lastRefillMs > maxIdleMs) {
        this.buckets.delete(key);
      }
    }
  }
}

export function createTokenBucketRateLimitMiddleware(options: TokenBucketOptions = {}) {
  const limiter = new TokenBucketRateLimiter(options);
  const keyGen = options.keyGenerator ?? defaultRateLimitKey;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyGen(req);
    const result = limiter.consume(key, 1);

    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(result.resetEpochSeconds));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Retry after ${result.retryAfterSeconds} second(s).`,
        retryAfter: result.retryAfterSeconds,
      });
      return;
    }

    next();
  };
}
