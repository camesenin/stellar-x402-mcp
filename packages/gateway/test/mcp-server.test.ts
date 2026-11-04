import { describe, it, expect, vi } from 'vitest';
import { StellarPaidMcpServer } from '../src/mcp-server.js';
import { ChallengeStore } from '../src/challenge-store.js';
import { StellarPaymentVerifier } from '../src/verifier.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Keypair } from '@stellar/stellar-sdk';

describe('StellarPaidMcpServer tools/call interception, binding, and transport', () => {
  const dummyDest = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  function setupServer(serverConfigOverrides: Record<string, unknown> = {}) {
    const store = new ChallengeStore(':memory:');
    const verifier = new StellarPaymentVerifier();
    const server = new StellarPaidMcpServer(
      {
        destinationPublicKey: dummyDest,
        defaultFeeXlm: '0.01',
        ...serverConfigOverrides,
      },
      store,
      verifier
    );

    const tool1Handler = vi.fn().mockResolvedValue({ success: true, tool: 1 });
    const tool2ExpensiveHandler = vi.fn().mockResolvedValue({ success: true, tool: 2 });
    const toolIdenticalPriceHandler = vi.fn().mockResolvedValue({ success: true, tool: 'identical' });
    const toolThreeUsdcHandler = vi.fn().mockResolvedValue({ success: true, tool: 'usdc' });

    // tool_one: 0.01 XLM
    server.registerTool({
      name: 'tool_one',
      description: 'First test tool',
      pricing: { amount: '0.01', asset: 'XLM' },
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      handler: tool1Handler,
    });

    // tool_two_expensive: 10.0 XLM
    server.registerTool({
      name: 'tool_two_expensive',
      description: 'Second test tool with higher price',
      pricing: { amount: '10.0', asset: 'XLM' },
      inputSchema: { type: 'object', properties: {} },
      handler: tool2ExpensiveHandler,
    });

    // tool_identical_price: EXACT SAME 0.01 XLM price as tool_one
    server.registerTool({
      name: 'tool_identical_price',
      description: 'Tool with identical 0.01 XLM price as tool_one',
      pricing: { amount: '0.01', asset: 'XLM' },
      inputSchema: { type: 'object', properties: {} },
      handler: toolIdenticalPriceHandler,
    });

    // tool_three_usdc: 1.0 USDC
    server.registerTool({
      name: 'tool_three_usdc',
      description: 'Tool priced in USDC',
      pricing: { amount: '1.0', asset: 'USDC' },
      inputSchema: { type: 'object', properties: {} },
      handler: toolThreeUsdcHandler,
    });

    const rawServer = server.getRawServer();
    const callHandler = (rawServer as unknown as { _requestHandlers: Map<string, Function> })
      ._requestHandlers.get('tools/call');

    if (!callHandler) {
      throw new Error("tools/call handler not registered on MCP server");
    }

    return {
      server,
      store,
      verifier,
      tool1Handler,
      tool2ExpensiveHandler,
      toolIdenticalPriceHandler,
      toolThreeUsdcHandler,
      callHandler,
    };
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

  it('rejects cross-tool challenge reuse even when prices and assets are 100% identical', async () => {
    const { store, callHandler, verifier, toolIdenticalPriceHandler } = setupServer();

    // Challenge created strictly for tool_one (0.01 XLM)
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
      // Attempt to invoke tool_identical_price (which ALSO costs 0.01 XLM) using tool_one's challenge
      await callHandler({
        method: 'tools/call',
        params: {
          name: 'tool_identical_price',
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
    expect(error?.message).toContain("challenge was issued for 'mcp://tool_one', but invoked for 'mcp://tool_identical_price'");
    expect(error?.message).toContain('Cross-tool challenge reuse is strictly prohibited');

    // Neither the verifier nor the tool handler was called
    expect(verifySpy).not.toHaveBeenCalled();
    expect(toolIdenticalPriceHandler).not.toHaveBeenCalled();

    // Challenge must remain unredeemed in active challenges
    const activeChallenge = store.getChallenge(challenge1.challengeId);
    expect(activeChallenge).toBeDefined();
    expect(activeChallenge?.challengeId).toBe(challenge1.challengeId);
  });

  it('rejects cross-tool challenge reuse with different prices', async () => {
    const { store, callHandler, verifier, tool2ExpensiveHandler } = setupServer();

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
    expect(verifySpy).not.toHaveBeenCalled();
    expect(tool2ExpensiveHandler).not.toHaveBeenCalled();
  });

  it('rejects invocation when challenge amount does not match tool pricing', async () => {
    const { store, callHandler, verifier, tool1Handler } = setupServer();

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

    const activeChallenge = store.getChallenge(challengeUnderpaid.challengeId);
    expect(activeChallenge).toBeDefined();
  });

  it('rejects invocation when challenge asset does not match tool asset and asserts handler not invoked', async () => {
    const { store, callHandler, verifier, toolThreeUsdcHandler } = setupServer();

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

    // Explicitly assert neither verifier nor toolThreeUsdcHandler was executed
    expect(verifySpy).not.toHaveBeenCalled();
    expect(toolThreeUsdcHandler).not.toHaveBeenCalled();

    const activeChallenge = store.getChallenge(challengeWrongAsset.challengeId);
    expect(activeChallenge).toBeDefined();
  });

  describe('Requester Authentication (requireRequesterAuth) in MCP', () => {
    it('rejects invocation when requireRequesterAuth is enabled and signature is absent', async () => {
      const { store, callHandler, verifier, tool1Handler } = setupServer({
        requireRequesterAuth: true,
      });

      const challenge = store.createChallenge(
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
        await callHandler({
          method: 'tools/call',
          params: {
            name: 'tool_one',
            arguments: {
              _x402_tx_hash: 'a'.repeat(64),
              _x402_challenge_id: challenge.challengeId,
              // _x402_payer_signature omitted!
            },
          },
        });
      } catch (err) {
        error = err as McpError;
      }

      expect(error).toBeInstanceOf(McpError);
      expect(error?.code).toBe(ErrorCode.InvalidParams);
      expect(error?.message).toContain('Requester Signature Required');
      expect(verifySpy).not.toHaveBeenCalled();
      expect(tool1Handler).not.toHaveBeenCalled();
    });

    it('rejects invocation when requireRequesterAuth is enabled and signature is invalid', async () => {
      const { store, callHandler, verifier, tool1Handler } = setupServer({
        requireRequesterAuth: true,
      });

      const challenge = store.createChallenge(
        dummyDest,
        '0.01',
        'XLM',
        'mcp://tool_one',
        'testnet',
        undefined,
        60000
      );

      // Verifier returns invalid due to bad signature
      vi.spyOn(verifier, 'verifyPayment').mockResolvedValue({
        valid: false,
        reason: 'Requester authentication failed: Domain-separated signature does not match on-chain payer keypair',
        txHash: 'a'.repeat(64),
      });

      let error: McpError | null = null;
      try {
        await callHandler({
          method: 'tools/call',
          params: {
            name: 'tool_one',
            arguments: {
              _x402_tx_hash: 'a'.repeat(64),
              _x402_challenge_id: challenge.challengeId,
              _x402_payer_signature: 'invalid_base64_signature',
            },
          },
        });
      } catch (err) {
        error = err as McpError;
      }

      expect(error).toBeInstanceOf(McpError);
      expect(error?.code).toBe(ErrorCode.InvalidRequest);
      expect(error?.message).toContain('Requester authentication failed');
      expect(tool1Handler).not.toHaveBeenCalled();
    });

    it('successfully validates invocation with valid domain-separated payer signature', async () => {
      const { store, callHandler, verifier, tool1Handler } = setupServer({
        requireRequesterAuth: true,
      });

      const payerKp = Keypair.random();
      const challenge = store.createChallenge(
        dummyDest,
        '0.01',
        'XLM',
        'mcp://tool_one',
        'testnet',
        undefined,
        60000
      );

      const txHash = 'a'.repeat(64);
      const gatewayResource = 'mcp://tool_one';
      const cleanHash = txHash.toLowerCase();
      const domainMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:${gatewayResource}:${challenge.challengeId}:${cleanHash}:${challenge.expiresAt}`;
      const validSig = payerKp.sign(Buffer.from(domainMessage, 'utf-8')).toString('base64');

      const verifySpy = vi.spyOn(verifier, 'verifyPayment').mockImplementation(
        async (_hash, _chall, _st, auth) => {
          expect(auth).toBeDefined();
          expect(auth?.message).toBe(domainMessage);
          expect(auth?.signatureBase64).toBe(validSig);

          // Cryptographic ed25519 verification
          const ok = payerKp.verify(Buffer.from(auth!.message, 'utf-8'), Buffer.from(auth!.signatureBase64, 'base64'));
          expect(ok).toBe(true);

          return {
            valid: true,
            payer: payerKp.publicKey(),
            amount: '0.01',
            asset: 'XLM',
            txHash,
          };
        }
      );

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'tool_one',
          arguments: {
            q: 'authorized query',
            _x402_tx_hash: txHash,
            _x402_challenge_id: challenge.challengeId,
            _x402_payer_signature: validSig,
          },
        },
      });

      expect(verifySpy).toHaveBeenCalled();
      expect(tool1Handler).toHaveBeenCalledWith(
        { q: 'authorized query' },
        expect.objectContaining({ valid: true, payer: payerKp.publicKey() })
      );
      expect(response.content[0].type).toBe('text');
      expect(JSON.parse(response.content[0].text)).toEqual({ success: true, tool: 1 });
    });
  });

  describe('Full End-to-End MCP Client and InMemoryTransport protocol execution', () => {
    it('executes full roundtrip client-to-server lifecycle through official MCP SDK transport', async () => {
      const { server, store, verifier, tool1Handler } = setupServer();

      // Create official MCP Client and linked InMemoryTransport pair
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: 'test-agent-client', version: '1.0.0' },
        { capabilities: {} }
      );

      // Connect server and client over real transport
      await server.getRawServer().connect(serverTransport);
      await mcpClient.connect(clientTransport);

      // 1. Tool discovery over real MCP wire
      const listRes = await mcpClient.listTools();
      expect(listRes.tools.some((t) => t.name === 'tool_one')).toBe(true);

      // 2. Unpaid call over real MCP wire throws actionable 402 challenge
      let callError: unknown = null;
      try {
        await mcpClient.callTool({
          name: 'tool_one',
          arguments: { q: 'unpaid wire test' },
        });
      } catch (err) {
        callError = err;
      }

      expect(callError).toBeDefined();
      const errMsg = (callError as Error).message;
      const jsonStart = errMsg.indexOf('{');
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const challengePayload = JSON.parse(errMsg.slice(jsonStart));
      expect(challengePayload.error).toBe('Payment Required');
      const challengeId = challengePayload.x402_challenge.challenge_id;

      // 3. Paid call over real MCP wire with valid payment
      vi.spyOn(verifier, 'verifyPayment').mockResolvedValue({
        valid: true,
        payer: 'GWIRE_AGENT_123',
        amount: '0.01',
        asset: 'XLM',
        txHash: 'e'.repeat(64),
      });

      const callSuccessRes = (await mcpClient.callTool({
        name: 'tool_one',
        arguments: {
          q: 'wire test paid',
          _x402_tx_hash: 'e'.repeat(64),
          _x402_challenge_id: challengeId,
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(callSuccessRes.content[0].type).toBe('text');
      expect(JSON.parse(callSuccessRes.content[0].text)).toEqual({ success: true, tool: 1 });
      expect(tool1Handler).toHaveBeenCalledWith(
        { q: 'wire test paid' },
        expect.objectContaining({ valid: true, payer: 'GWIRE_AGENT_123' })
      );

      // Clean teardown
      await mcpClient.close();
      await server.getRawServer().close();
    });
    it('executes real MCP wire protocol with requireRequesterAuth enabled and authentic Stellar verification', async () => {
      const { server, store, verifier, tool1Handler } = setupServer({
        requireRequesterAuth: true,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: 'authenticated-wire-agent', version: '1.0.0' },
        { capabilities: {} }
      );

      await server.getRawServer().connect(serverTransport);
      await mcpClient.connect(clientTransport);

      // 1. Initial tool call without payment -> intercepts with challenge
      let unpaidErr: unknown = null;
      try {
        await mcpClient.callTool({
          name: 'tool_one',
          arguments: { q: 'authenticated query' },
        });
      } catch (err) {
        unpaidErr = err;
      }

      expect(unpaidErr).toBeDefined();
      const errMsg = (unpaidErr as Error).message;
      const parsedChallenge = JSON.parse(errMsg.slice(errMsg.indexOf('{')));
      const challengeId = parsedChallenge.x402_challenge.challenge_id;
      const expiresAt = parsedChallenge.x402_challenge.expires_at;

      // 2. Setup real payer keypair and authentic Horizon mock for verifyPayment
      const payerKp = Keypair.random();
      const wireTxHash = 'f'.repeat(64);
      const mockHorizonTx = {
        id: wireTxHash,
        successful: true,
        source_account: payerKp.publicKey(),
        memo: parsedChallenge.x402_challenge.memo,
        ledger_attr: 70001,
        operations: async () => ({
          records: [
            {
              type: 'payment',
              to: dummyDest,
              source_account: payerKp.publicKey(),
              amount: '0.01',
              asset_type: 'native',
            },
          ],
          next: async () => ({ records: [] }),
        }),
      };

      // Mock ONLY external Horizon endpoint; StellarPaymentVerifier logic and crypto verification remain 100% UNTOUCHED!
      vi.spyOn((verifier as any).horizonServer, 'transactions').mockReturnValue({
        transaction: () => ({
          call: async () => mockHorizonTx,
        }),
      } as any);

      // 3. Compute authentic domain signature
      const gatewayResource = 'mcp://tool_one';
      const cleanHash = wireTxHash.toLowerCase();
      const domainMsg = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:${gatewayResource}:${challengeId}:${cleanHash}:${expiresAt}`;
      const validSignature = payerKp.sign(Buffer.from(domainMsg, 'utf-8')).toString('base64');

      // 4. First execution with valid payment and valid signature -> SUCCESS
      const firstCallRes = (await mcpClient.callTool({
        name: 'tool_one',
        arguments: {
          q: 'authenticated query',
          _x402_tx_hash: wireTxHash,
          _x402_challenge_id: challengeId,
          _x402_payer_signature: validSignature,
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(firstCallRes.content[0].type).toBe('text');
      expect(JSON.parse(firstCallRes.content[0].text)).toEqual({ success: true, tool: 1 });
      expect(tool1Handler).toHaveBeenCalledTimes(1);
      expect(store.isTxRedeemed(wireTxHash)).toBe(true);
      expect(store.getChallenge(challengeId)).toBeUndefined(); // Challenge consumed!

      // 5. Replay attempt using same settled txHash and challengeId -> REJECTED (anti-replay)
      let replayErr: unknown = null;
      try {
        await mcpClient.callTool({
          name: 'tool_one',
          arguments: {
            q: 'replay attack',
            _x402_tx_hash: wireTxHash,
            _x402_challenge_id: challengeId,
            _x402_payer_signature: validSignature,
          },
        });
      } catch (err) {
        replayErr = err;
      }

      expect(replayErr).toBeDefined();
      expect((replayErr as Error).message).toContain('Invalid or expired x402 challenge ID');
      expect(tool1Handler).toHaveBeenCalledTimes(1); // Handler was NOT invoked a second time

      await mcpClient.close();
      await server.getRawServer().close();
    });
  });
});
