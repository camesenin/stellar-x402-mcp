import { describe, it, expect, vi } from 'vitest';
import { StellarPaidMcpServer } from '../src/mcp-server.js';
import { ChallengeStore } from '../src/challenge-store.js';
import { StellarPaymentVerifier } from '../src/verifier.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

describe('StellarPaidMcpServer tools/call interception and binding', () => {
  const dummyDest = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  function setupServer() {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    const server = new StellarPaidMcpServer(
      {
        destinationPublicKey: dummyDest,
        defaultFeeXlm: '0.01',
      },
      store,
      verifier
    );

    const tool1Handler = vi.fn().mockResolvedValue({ success: true, tool: 1 });
    const tool2Handler = vi.fn().mockResolvedValue({ success: true, tool: 2 });

    server.registerTool({
      name: 'tool_one',
      description: 'First test tool',
      pricing: { amount: '0.01', asset: 'XLM' },
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      handler: tool1Handler,
    });

    server.registerTool({
      name: 'tool_two_expensive',
      description: 'Second test tool with higher price',
      pricing: { amount: '10.0', asset: 'XLM' },
      inputSchema: { type: 'object', properties: {} },
      handler: tool2Handler,
    });

    server.registerTool({
      name: 'tool_three_usdc',
      description: 'Tool priced in USDC',
      pricing: { amount: '1.0', asset: 'USDC' },
      inputSchema: { type: 'object', properties: {} },
      handler: vi.fn(),
    });

    const rawServer = server.getRawServer();
    const callHandler = (rawServer as unknown as { _requestHandlers: Map<string, Function> })
      ._requestHandlers.get('tools/call');

    if (!callHandler) {
      throw new Error("tools/call handler not registered on MCP server");
    }

    return { server, store, verifier, tool1Handler, tool2Handler, callHandler };
  }

  it('issues x402 challenge when tool is invoked without payment proof', async () => {
    const { callHandler, tool1Handler } = setupServer();

    let error: McpError | null = null;
    try {
      await callHandler({
        method: 'tools/call',
        params: { name: 'tool_one', arguments: { q: 'test' } },
      });
    } catch (err) {
      error = err as McpError;
    }

    expect(error).toBeInstanceOf(McpError);
    expect(error?.code).toBe(ErrorCode.InvalidRequest);
    const jsonStart = error!.message.indexOf('{');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(error!.message.slice(jsonStart));
    expect(parsed.error).toBe('Payment Required');
    expect(parsed.x402_challenge.amount).toBe('0.01');
    expect(parsed.x402_challenge.asset).toBe('XLM');
    expect(parsed.x402_challenge.destination).toBe(dummyDest);
    expect(tool1Handler).not.toHaveBeenCalled();
  });

  it('rejects cross-tool challenge reuse even if prices are identical', async () => {
    const { store, callHandler, verifier, tool2Handler } = setupServer();

    // Create a challenge explicitly for tool_one
    const challenge1 = store.createChallenge(
      dummyDest,
      '0.01',
      'XLM',
      'mcp://tool_one',
      'testnet',
      undefined,
      60000
    );

    const verifySpy = vi.spyOn(verifier, 'verifyPayment');

    let error: McpError | null = null;
    try {
      // Attempt to invoke tool_two_expensive using tool_one's challenge
      await callHandler({
        method: 'tools/call',
        params: {
          name: 'tool_two_expensive',
          arguments: {
            _x402_tx_hash: 'd'.repeat(64),
            _x402_challenge_id: challenge1.challengeId,
          },
        },
      });
    } catch (err) {
      error = err as McpError;
    }

    expect(error).toBeInstanceOf(McpError);
    expect(error?.code).toBe(ErrorCode.InvalidParams);
    expect(error?.message).toContain('x402 Challenge resource mismatch');
    expect(error?.message).toContain("challenge was issued for 'mcp://tool_one', but invoked for 'mcp://tool_two_expensive'");
    expect(error?.message).toContain('Cross-tool challenge reuse is strictly prohibited');

    // Verifier must NOT have been called, and tool handler must NOT have executed
    expect(verifySpy).not.toHaveBeenCalled();
    expect(tool2Handler).not.toHaveBeenCalled();

    // Challenge must not have been consumed/redeemed (remains retrievable in active challenges)
    const activeChallenge = store.getChallenge(challenge1.challengeId);
    expect(activeChallenge).toBeDefined();
    expect(activeChallenge?.challengeId).toBe(challenge1.challengeId);
  });

  it('rejects invocation when challenge amount does not match tool pricing', async () => {
    const { store, callHandler, verifier, tool1Handler } = setupServer();

    // Create a challenge for tool_one but with underpaid pricing
    const challengeUnderpaid = store.createChallenge(
      dummyDest,
      '0.005', // tool_one requires 0.01
      'XLM',
      'mcp://tool_one',
      'testnet',
      undefined,
      60000
    );

    const verifySpy = vi.spyOn(verifier, 'verifyPayment');

    let error: McpError | null = null;
    try {
      await callHandler({
        method: 'tools/call',
        params: {
          name: 'tool_one',
          arguments: {
            _x402_tx_hash: 'd'.repeat(64),
            _x402_challenge_id: challengeUnderpaid.challengeId,
          },
        },
      });
    } catch (err) {
      error = err as McpError;
    }

    expect(error).toBeInstanceOf(McpError);
    expect(error?.code).toBe(ErrorCode.InvalidParams);
    expect(error?.message).toContain('x402 Challenge pricing mismatch');
    expect(error?.message).toContain('0.005 XLM');
    expect(error?.message).toContain('0.01 XLM');
    expect(verifySpy).not.toHaveBeenCalled();
    expect(tool1Handler).not.toHaveBeenCalled();

    // Challenge remains unconsumed
    const activeChallenge = store.getChallenge(challengeUnderpaid.challengeId);
    expect(activeChallenge).toBeDefined();
  });

  it('rejects invocation when challenge asset does not match tool asset', async () => {
    const { store, callHandler, verifier } = setupServer();

    // Create a challenge for tool_three_usdc but with XLM instead of USDC
    const challengeWrongAsset = store.createChallenge(
      dummyDest,
      '1.0',
      'XLM', // tool_three requires USDC
      'mcp://tool_three_usdc',
      'testnet',
      undefined,
      60000
    );

    const verifySpy = vi.spyOn(verifier, 'verifyPayment');

    let error: McpError | null = null;
    try {
      await callHandler({
        method: 'tools/call',
        params: {
          name: 'tool_three_usdc',
          arguments: {
            _x402_tx_hash: 'd'.repeat(64),
            _x402_challenge_id: challengeWrongAsset.challengeId,
          },
        },
      });
    } catch (err) {
      error = err as McpError;
    }

    expect(error).toBeInstanceOf(McpError);
    expect(error?.code).toBe(ErrorCode.InvalidParams);
    expect(error?.message).toContain('x402 Challenge pricing mismatch');
    expect(error?.message).toContain('1.0 XLM');
    expect(error?.message).toContain('1.0 USDC');
    expect(verifySpy).not.toHaveBeenCalled();

    const activeChallenge = store.getChallenge(challengeWrongAsset.challengeId);
    expect(activeChallenge).toBeDefined();
  });

  it('successfully invokes tool handler and strips internal headers when payment is valid', async () => {
    const { store, callHandler, verifier, tool1Handler } = setupServer();

    const challenge = store.createChallenge(
      dummyDest,
      '0.01',
      'XLM',
      'mcp://tool_one',
      'testnet',
      undefined,
      60000
    );

    vi.spyOn(verifier, 'verifyPayment').mockResolvedValue({
      valid: true,
      payer: 'GCLIENT_PAYER_123',
      amount: '0.01',
      asset: 'XLM',
      txHash: 'a'.repeat(64),
    });

    const response = await callHandler({
      method: 'tools/call',
      params: {
        name: 'tool_one',
        arguments: {
          q: 'alpha query',
          _x402_tx_hash: 'a'.repeat(64),
          _x402_challenge_id: challenge.challengeId,
        },
      },
    });

    expect(response.content[0].type).toBe('text');
    expect(JSON.parse(response.content[0].text)).toEqual({ success: true, tool: 1 });

    // Ensure tool handler received only clean arguments (stripped of _x402_*)
    expect(tool1Handler).toHaveBeenCalledWith(
      { q: 'alpha query' },
      expect.objectContaining({ valid: true, payer: 'GCLIENT_PAYER_123' })
    );
  });
});
