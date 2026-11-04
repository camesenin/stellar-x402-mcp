import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ClientConfig, ParsedChallenge } from './types.js';
import { BudgetManager } from './budget.js';
import { StellarPayer } from './payer.js';

export class StellarPaidMcpClient {
  private payer: StellarPayer;
  private budget: BudgetManager;

  constructor(
    private mcpClient: Client,
    config: ClientConfig
  ) {
    this.payer = new StellarPayer(config);
    this.budget = new BudgetManager(
      config.maxPaymentPerCallXlm ?? 1.0,
      config.totalBudgetLimitXlm ?? 10.0
    );
  }

  /**
   * Execute an MCP tool call with automatic x402 payment negotiation
   */
  public async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    try {
      // First attempt
      return await this.mcpClient.callTool({
        name,
        arguments: args,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Check if error contains x402 challenge JSON payload
      let challenge: ParsedChallenge | null = null;
      try {
        const jsonStart = errorMsg.indexOf('{');
        if (jsonStart !== -1) {
          const jsonStr = errorMsg.slice(jsonStart);
          const parsed = JSON.parse(jsonStr);
          if (parsed.x402_challenge) {
            const raw = parsed.x402_challenge;
            challenge = {
              challengeId: raw.challenge_id || raw.challengeId,
              destination: raw.destination,
              amount: raw.amount,
              asset: raw.asset || 'XLM',
              memo: raw.memo || raw.challenge_id,
              network: raw.network || 'testnet',
              contractId: raw.contract_id,
              expiresAt: raw.expires_at,
            };
          }
        }
      } catch {
        // Not a JSON error message, rethrow original error
        throw err;
      }

      if (!challenge) {
        throw err;
      }

      // Budget check & concurrent reservation
      const costXlm = parseFloat(challenge.amount);
      const reservationId = this.budget.reserve(costXlm);
      const attemptStartSec = Math.floor(Date.now() / 1000);

      let receipt;
      try {
        // Settle challenge on Stellar
        receipt = await this.payer.settleChallenge(challenge);
        this.budget.finalize(reservationId, challenge.destination, receipt.txHash);
      } catch (paymentErr: any) {
        const localWaitEpochMs = Date.now() + 75_000;
        const authenticMaxTimeSec = typeof paymentErr?.maxTime === 'number' && paymentErr.maxTime > 0 ? paymentErr.maxTime : undefined;
        const txHash = paymentErr?.txHash ?? undefined;
        this.budget.release(reservationId, { epochMs: localWaitEpochMs }, txHash, challenge.destination, attemptStartSec, authenticMaxTimeSec);
        throw paymentErr;
      }

      // Re-invoke with payment proof (with retriable 503 recovery without double payment)
      let mcpRetryAttempts = 0;
      while (true) {
        try {
          return await this.mcpClient.callTool({
            name,
            arguments: {
              ...args,
              _x402_tx_hash: receipt.txHash,
              _x402_challenge_id: challenge.challengeId,
            },
          });
        } catch (callErr: any) {
          const isRetriable503 = callErr?.data?.retriable === true && callErr?.data?.statusCode === 503;
          if (isRetriable503 && mcpRetryAttempts < 3) {
            mcpRetryAttempts++;
            // Exponential backoff: base 500ms * 2^attempts (1000ms, 2000ms, 4000ms)
            const baseWaitMs = 500 * Math.pow(2, mcpRetryAttempts);
            const serverSec = callErr?.data?.retryAfterSec;
            const validServerSec = typeof serverSec === 'number' && !isNaN(serverSec) && serverSec > 0 ? Math.floor(serverSec) : 0;
            const serverWaitMs = validServerSec * 1000;
            const waitMs = Math.max(baseWaitMs, serverWaitMs);

            if (waitMs > 30_000) {
              throw callErr;
            }

            await new Promise(resolve => setTimeout(resolve, waitMs));
            continue;
          }
          throw callErr;
        }
      }
    }
  }

  public getRawClient(): Client {
    return this.mcpClient;
  }

  public getBudgetManager(): BudgetManager {
    return this.budget;
  }

  public getPayer(): StellarPayer {
    return this.payer;
  }
}
