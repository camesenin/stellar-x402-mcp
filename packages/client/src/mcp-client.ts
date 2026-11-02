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

      let receipt;
      try {
        // Settle challenge on Stellar
        receipt = await this.payer.settleChallenge(challenge);
        this.budget.finalize(reservationId, challenge.destination, receipt.txHash);
      } catch (paymentErr) {
        this.budget.release(reservationId);
        throw paymentErr;
      }

      // Re-invoke with payment proof
      return await this.mcpClient.callTool({
        name,
        arguments: {
          ...args,
          _x402_tx_hash: receipt.txHash,
          _x402_challenge_id: challenge.challengeId,
        },
      });
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
