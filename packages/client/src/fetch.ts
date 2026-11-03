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
      // Hold in quarantine if transaction had a time bound or in-flight timeout
      const keepUntil = paymentErr?.maxTime ? paymentErr.maxTime : Date.now() + 75_000;
      budget.release(reservationId, keepUntil);
      throw paymentErr;
    }

    // 6. Retry request with payment proof headers
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

    return await fetch(input, retryInit);
  };
}
