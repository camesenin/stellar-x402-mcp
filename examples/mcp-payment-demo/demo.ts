/**
 * End-to-end Demonstration of Stellar x402 Micropayments with Model Context Protocol (MCP)
 */
import { Keypair } from '@stellar/stellar-sdk';
import {
  StellarPaidMcpServer,
  ChallengeStore,
  StellarPaymentVerifier,
} from '@stellar-x402/gateway';

async function main() {
  console.log('================================================================');
  console.log('🤖 STELLAR x402 + MCP: AUTONOMOUS AGENT MICROPAYMENT DEMO');
  console.log('================================================================\n');

  // 1. Generate merchant/gateway keys
  const merchantPair = Keypair.random();
  console.log('1. Gateway initialized for Merchant:');
  console.log(`   Public Address: ${merchantPair.publicKey()}`);

  // 2. Initialize Gateway & Challenge Store
  const store = new ChallengeStore();
  const verifier = new StellarPaymentVerifier();
  const server = new StellarPaidMcpServer(
    {
      destinationPublicKey: merchantPair.publicKey(),
      network: 'testnet',
      defaultFeeXlm: '0.01',
    },
    store,
    verifier
  );

  // 3. Register a paid MCP Tool
  server.registerTool({
    name: 'generate_market_alpha',
    description: 'Generates real-time AI liquidity analysis and on-chain alpha.',
    pricing: {
      amount: '0.01',
      asset: 'XLM',
    },
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Asset symbol, e.g. XLM' },
      },
      required: ['symbol'],
    },
    handler: async (args, payment) => {
      return {
        symbol: args.symbol,
        alpha: 'Bullish orderflow divergence detected across Soroban DEX pools.',
        paid_by: payment.payer,
        verified_tx: payment.txHash,
        settled_amount: `${payment.amount} ${payment.asset}`,
      };
    },
  });

  console.log('\n2. Registered Paid MCP Tool:');
  console.log(`   Tool Name: 'generate_market_alpha'`);
  console.log(`   Price:     0.01 XLM per execution`);

  // 4. Simulate Agent Call without payment
  console.log('\n3. Autonomous Agent initiates tool call WITHOUT payment proof...');
  const rawServer = server.getRawServer();

  try {
    const listHandler = (rawServer as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get('tools/call');
    if (listHandler) {
      await listHandler({
        method: 'tools/call',
        params: {
          name: 'generate_market_alpha',
          arguments: { symbol: 'XLM' },
        },
      });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log('   🛑 Gateway intercepted call with HTTP 402 challenge:');
    const jsonStart = errorMsg.indexOf('{');
    const parsed = JSON.parse(errorMsg.slice(jsonStart));
    console.log(JSON.stringify(parsed, null, 2));

    const challenge = parsed.x402_challenge;

    // 5. Simulate Agent Settle & Retry
    console.log('\n4. Agent validates budget (< 1.0 XLM) and signs settlement...');
    const dummyAgentTxHash = 'd7a8f102c938b7e294101e820c7493a19e2730198402b81093a1029481720194';
    console.log(`   Payment executed on Stellar Testnet!`);
    console.log(`   TxHash: ${dummyAgentTxHash}`);
    console.log(`   Memo:   ${challenge.memo}`);

    // Mock verifier for demo execution
    verifier.verifyPayment = async () => ({
      valid: true,
      payer: 'GAUTONOMOUS_AI_AGENT_KEYPAIR_999999999999999999999999999999',
      amount: challenge.amount,
      asset: challenge.asset,
      ledger: 624102,
      txHash: dummyAgentTxHash,
    });

    console.log('\n5. Agent re-invokes MCP tool with payment proof headers:');
    const listHandler = (rawServer as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get('tools/call');
    if (listHandler) {
      const response = await listHandler({
        method: 'tools/call',
        params: {
          name: 'generate_market_alpha',
          arguments: {
            symbol: 'XLM',
            _x402_tx_hash: dummyAgentTxHash,
            _x402_challenge_id: challenge.challenge_id,
          },
        },
      });

      console.log('   🎉 Execution Successful! Tool payload returned:');
      console.log(JSON.stringify(response, null, 2));
    }
  }

  console.log('\n================================================================');
  console.log('✅ DEMO COMPLETE: x402 Micropayment Flow Successfully Demonstrated');
  console.log('================================================================');
}

main().catch(console.error);
