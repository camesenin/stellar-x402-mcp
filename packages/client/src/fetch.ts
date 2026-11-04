import { ClientConfig } from './types.js';
import { BudgetManager } from './budget.js';
import { StellarPayer } from './payer.js';
import { parseX402Challenge } from './parser.js';

export function createX402Fetch(config: ClientConfig) {
  const payer = new StellarPayer(config);
  const budget = new BudgetManager(
    config.maxPaymentPerCallXlm ?? 1.0,
    config.totalBudgetLimitXlm ?? 10.0
  );

  return async function x402Fetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // 1. Initial request
    let response = await fetch(input, init);

    // If not 402, return immediately
    if (response.status !== 402) {
      return response;
    }

    // 2. Clone response to read body without consuming stream
    const clone = response.clone();
    let jsonBody: Record<string, unknown> | undefined;
    try {
      jsonBody = (await clone.json()) as Record<string, unknown>;
    } catch {
      // Body may not be JSON
    }

    // 3. Parse challenge
    const challenge = parseX402Challenge(response.headers, jsonBody);

    // 4. Concurrency-safe budget reservation
    const costXlm = parseFloat(challenge.amount);
    const reservationId = budget.reserve(costXlm);

    let receipt;
    try {
      // 5. Submit payment on Stellar
      receipt = await payer.settleChallenge(challenge);
      budget.finalize(reservationId, challenge.destination, receipt.txHash);
    } catch (paymentErr: any) {
      // Hold in quarantine: local wait timer (75s) strictly separated from authentic envelope signed maxTime
      const localWaitEpochMs = Date.now() + 75_000;
      const authenticMaxTimeSec = typeof paymentErr?.maxTime === 'number' && paymentErr.maxTime > 0 ? paymentErr.maxTime : undefined;
      budget.release(reservationId, { epochMs: localWaitEpochMs }, paymentErr?.txHash, challenge.destination, undefined, authenticMaxTimeSec);
      throw paymentErr;
    }

    // 6. Retry request with payment proof headers (with retriable 503 recovery)
    const newHeaders = new Headers(init?.headers);
    newHeaders.set('X-Stellar-TxHash', receipt.txHash);
    newHeaders.set('X-Challenge-Id', challenge.challengeId);
    newHeaders.set(
      'Authorization',
      `StellarX402 txHash="${receipt.txHash}", challenge_id="${challenge.challengeId}"`
    );

    const retryInit: RequestInit = {
      ...init,
      headers: newHeaders,
    };

    let retryResponse = await fetch(input, retryInit);

    // If server returned 503 verification error, retry verification with exponential backoff reusing the same receipt
    let retryAttempts = 0;
    while (retryResponse.status === 503 && retryAttempts < 3) {
      // Clone response to check structured body if available
      const clone503 = retryResponse.clone();
      let isVerifiedRetriable = false;
      try {
        const body503 = await clone503.json() as any;
        if (body503 && body503.retriable === true) {
          isVerifiedRetriable = true;
        }
      } catch {
        // Not JSON
      }

      if (!isVerifiedRetriable) {
        break; // Do not retry generic 503 errors unrelated to payment verification
      }

      retryAttempts++;
      let waitMs = 500 * Math.pow(2, retryAttempts); // Exponential backoff: 1000ms, 2000ms, 4000ms
      const retryAfterHeader = retryResponse.headers.get('Retry-After');
      if (retryAfterHeader) {
        const parsedSec = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedSec) && parsedSec > 0) {
          waitMs = Math.max(waitMs, parsedSec * 1000);
        } else {
          const parsedDate = Date.parse(retryAfterHeader);
          if (!isNaN(parsedDate) && parsedDate > Date.now()) {
            waitMs = Math.max(waitMs, parsedDate - Date.now());
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 5000)));
      retryResponse = await fetch(input, retryInit);
    }

    return retryResponse;
  };
}
