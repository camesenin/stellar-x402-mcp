import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { GatewayConfig, PaidToolDefinition } from './types.js';
import { ChallengeStore } from './challenge-store.js';
import { StellarPaymentVerifier } from './verifier.js';

export class StellarPaidMcpServer {
  private server: Server;
  private tools = new Map<string, PaidToolDefinition>();

  constructor(
    private config: GatewayConfig,
    private store: ChallengeStore,
    private verifier: StellarPaymentVerifier,
    serverInfo = { name: 'stellar-x402-gateway', version: '0.1.0' }
  ) {
    this.server = new Server(serverInfo, {
      capabilities: {
        tools: {},
      },
    });

    this.registerHandlers();
  }

  public registerTool(tool: PaidToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  private registerHandlers(): void {
    // 1. Tool discovery
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const toolList = Array.from(this.tools.values()).map((tool) => ({
        name: tool.name,
        description: `${tool.description}\n[Price: ${tool.pricing.amount} ${tool.pricing.asset} via Stellar x402]`,
        inputSchema: {
          type: 'object',
          properties: {
            ...((tool.inputSchema.properties as Record<string, unknown>) || {}),
            _x402_tx_hash: {
              type: 'string',
              description: 'Stellar transaction hash settling the required x402 challenge',
            },
            _x402_challenge_id: {
              type: 'string',
              description: 'Active challenge ID being settled',
            },
            _x402_payer_signature: {
              type: 'string',
              description: 'Cryptographic signature from payer keypair binding challengeId and txHash for anti front-running',
            },
          },
          required: ((tool.inputSchema.required as string[]) || []),
        },
      }));

      return { tools: toolList };
    });

    // 2. Paid tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.tools.get(request.params.name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
      }

      const args = (request.params.arguments || {}) as Record<string, unknown>;
      const txHash = (args._x402_tx_hash as string)?.trim();
      const challengeId = (args._x402_challenge_id as string)?.trim();
      const payerSignature = (args._x402_payer_signature as string)?.trim();

      // Check if payment was provided
      if (txHash && challengeId) {
        const challenge = this.store.getChallenge(challengeId);
        if (!challenge) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid or expired x402 challenge ID. Request fresh challenge without payment.'
          );
        }

        // Strict resource binding: prevent cross-tool challenge reuse (e.g. paying for cheap tool and invoking expensive tool)
        const expectedResource = `mcp://${request.params.name}`;
        if (challenge.resource !== expectedResource) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `x402 Challenge resource mismatch: challenge was issued for '${challenge.resource}', but invoked for '${expectedResource}'. Cross-tool challenge reuse is strictly prohibited.`
          );
        }

        // Strict pricing binding: verify challenge amount and asset match currently requested tool pricing
        if (challenge.amount !== tool.pricing.amount || challenge.asset !== tool.pricing.asset) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `x402 Challenge pricing mismatch: challenge amount/asset (${challenge.amount} ${challenge.asset}) does not match required tool pricing (${tool.pricing.amount} ${tool.pricing.asset}).`
          );
        }

        // Requester binding defense (anti front-running)
        if (this.config.requireRequesterAuth && !payerSignature) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Requester Signature Required: This gateway requires _x402_payer_signature binding challengeId and txHash.'
          );
        }

        const gatewayResource = `mcp://${request.params.name}`;
        const cleanHash = txHash.trim().toLowerCase();
        const domainMessage = `stellar-x402:v1:${this.verifier.getNetworkPassphrase()}:${gatewayResource}:${challengeId}:${cleanHash}:${challenge.expiresAt}`;

        const requesterAuth = payerSignature
          ? { message: domainMessage, signatureBase64: payerSignature }
          : undefined;

        const verification = await this.verifier.verifyPayment(txHash, challenge, this.store, requesterAuth);
        if (!verification.valid) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `x402 Payment verification failed: ${verification.reason}`
          );
        }

        // Clean internal x402 fields before passing to tool handler
        const cleanArgs = { ...args };
        delete cleanArgs._x402_tx_hash;
        delete cleanArgs._x402_challenge_id;
        delete cleanArgs._x402_payer_signature;

        const result = await tool.handler(cleanArgs, verification);
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // No payment: Issue x402 challenge formatted as an actionable error
      const challenge = this.store.createChallenge(
        this.config.destinationPublicKey,
        tool.pricing.amount,
        tool.pricing.asset,
        `mcp://${request.params.name}`,
        this.config.network ?? 'testnet',
        this.config.contractId,
        this.config.challengeTtlMs
      );

      const challengeMessage = JSON.stringify({
        error: 'Payment Required',
        x402_challenge: {
          challenge_id: challenge.challengeId,
          destination: challenge.destination,
          amount: challenge.amount,
          asset: challenge.asset,
          memo: challenge.memo,
          network: challenge.network,
          expires_at: challenge.expiresAt,
        },
        instruction: `To invoke tool '${tool.name}', send ${challenge.amount} ${challenge.asset} to ${challenge.destination} with memo '${challenge.memo}', then re-invoke with arguments '_x402_tx_hash' and '_x402_challenge_id'.`,
      });

      throw new McpError(ErrorCode.InvalidRequest, challengeMessage);
    });
  }

  public getRawServer(): Server {
    return this.server;
  }
}
