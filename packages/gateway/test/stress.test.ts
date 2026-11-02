import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChallengeStore } from '../src/challenge-store.js';
import { RateLimiter } from '../src/middleware.js';

describe('Concurrency & Burst Stress Testing (Day 5)', () => {
  let tempDbPath: string;
  let store: ChallengeStore;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `x402_stress_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`
    );
    store = new ChallengeStore(tempDbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // Windows locking tolerance
      }
    }
  });

  it('handles 100 concurrent challenge creations and insertions without lock contention', async () => {
    const concurrency = 100;
    const promises = Array.from({ length: concurrency }, (_, i) => {
      return Promise.resolve().then(() => {
        return store.createChallenge(
          'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          '0.01',
          'XLM',
          `/resource-${i}`
        );
      });
    });

    const challenges = await Promise.all(promises);
    expect(challenges).toHaveLength(100);

    // Verify all 100 exist and have unique IDs
    const ids = new Set(challenges.map((c) => c.challengeId));
    expect(ids.size).toBe(100);

    for (const c of challenges) {
      const fetched = store.getChallenge(c.challengeId);
      expect(fetched).toBeDefined();
      expect(fetched?.challengeId).toBe(c.challengeId);
    }
  });

  it('enforces token bucket rate limiting under 100 rapid burst requests from single IP', () => {
    const limiter = new RateLimiter(60, 60_000); // 60 req/min
    const ip = '198.51.100.42';

    let allowed = 0;
    let blocked = 0;

    for (let i = 0; i < 100; i++) {
      if (limiter.isAllowed(ip)) {
        allowed++;
      } else {
        blocked++;
      }
    }

    expect(allowed).toBe(60);
    expect(blocked).toBe(40);
  });
});
