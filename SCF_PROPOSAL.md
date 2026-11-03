# Stellar Community Fund (SCF) #46 Proposal Dossier

## Project Information

- **Project Title**: `stellar-x402-mcp` (Stellar Agent Gateway & x402 Micropayment Facilitator for Model Context Protocol)
- **Track**: Build Award — RFP Track: Developer Tooling & Autonomous AI Agent Infrastructure
- **Target Deadline**: Round #46 (November 8, 2026)
- **Primary Repository**: [github.com/camesenin/stellar-x402-mcp](https://github.com/camesenin/stellar-x402-mcp)
- **License**: Apache-2.0
- **Lead Developer**: Carlos Murillo (`camesenin`)

---

## 1. Executive Summary

Autonomous AI agents (such as those running in Claude Desktop, Cursor, Antigravity, and LangChain) are rapidly becoming primary consumers of APIs and computational tools. However, machines cannot obtain credit cards or negotiate monthly SaaS subscriptions. 

`stellar-x402-mcp` provides open-source developer tooling that connects the emerging **Model Context Protocol (MCP)** standard with **HTTP 402 ("Payment Required")** on **Stellar & Soroban**.

Unlike high-fee chains where micropayments are economically impossible, Stellar’s **~$0.00001 fees**, **sub-5-second finality**, and **native memo architecture** make it the undisputed optimal payment layer for machine-to-machine intelligence.

**Crucially, this project is NOT a theoretical pitch.** Prior to submitting this proposal, the full monorepo has been architected, coded, verified with Soroban SDK 22, unit-tested (100% pass rate), and published with an end-to-end working demonstration.

---

## 2. Problem Statement

1. **The Machine Economy Has No Credit Cards**: AI agents executing autonomous reasoning loops need to pay per tool call (e.g., database queries, image generation, web search, compute). Monthly subscriptions require human KYC and manual credit card entry.
2. **High-Gas Blockchains Fail at Micropayments**: On Ethereum or Solana, a $0.01 tool query costs more in gas fees than the query itself, with unpredictable latency.
3. **Lack of MCP-Native Payment Tooling**: While Anthropic's Model Context Protocol (MCP) is the dominant standard for AI agents to connect to external systems, MCP lacked a turnkey way for tool creators to monetize per-call via Stellar.

---

## 3. The Solution: `stellar-x402-mcp`

`stellar-x402-mcp` delivers a modular developer stack:

1. **`packages/gateway`**:
   - HTTP 402 middleware for Express / Node.js.
   - MCP Server wrapper allowing any tool developer to attach a price in XLM or Soroban tokens.
   - Automatic challenge generation with cryptographic nonces and ephemeral TTLs.
   - On-chain transaction verifier querying Stellar Horizon and Soroban RPC with replay prevention.
2. **`packages/client`**:
   - Drop-in `x402Fetch` and `StellarPaidMcpClient`.
   - Autonomous negotiation: intercepts 402, evaluates local budget limits (preventing runaway agent costs), signs payment with local Keypair, and resubmits request transparently.
3. **`packages/contracts` (`X402PaymentVault`)**:
   - Production-grade Soroban smart contract compiled to Wasm (`<15KB`).
   - On-chain receipt registration, token transfer execution, and replay prevention.
4. **`packages/cli` (`x402-stellar`)**:
   - Developer CLI for rapid gateway deployment, key generation, testnet faucet integration, transaction verification, and manual micropayment settlement.

---

## 4. Current State & Verification Evidence

As of proposal preparation:
- **Deployed Soroban Contract**: Live on Testnet at [`CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO`](https://stellar.expert/explorer/testnet/contract/CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO) (Ledger 5528291, TxHash: [`8b123ea331abcf692dd70e1d808992dcf97988db64b36496cf7a276e6024a88e`](https://stellar.expert/explorer/testnet/tx/8b123ea331abcf692dd70e1d808992dcf97988db64b36496cf7a276e6024a88e)).
- **Live On-Chain Settlement**: Real testnet transaction confirmed at [`e6bf8005c3d0b680257448a2deb4ce785026377237fefab7753318664b4d2d36`](https://stellar.expert/explorer/testnet/tx/e6bf8005c3d0b680257448a2deb4ce785026377237fefab7753318664b4d2d36) (Ledger `5528366`), transferring native XLM SAC with verified contract receipt.
- **Cryptographic Durability Artifact**: Raw RPC response, envelope XDR, and diagnostic events preserved in [`testnet_evidence_pack.json`](./testnet_evidence_pack.json), ensuring persistent verification immune to Testnet ledger resets.
- **Rust Contract Unit Tests**: 8/8 passing (`packages/contracts/src/lib.rs`), asserting amount validation, payer authorization, insufficient balance checks, receipt retrieval, replay panic, multi-challenge isolation, and adversarial griefing slot-burning immunity.
- **TypeScript Test Suite**: 34/34 passing across `@stellar-x402/gateway` (18), `@stellar-x402/client` (14), `@stellar-x402/cli` (1), and `examples/mcp-payment-demo` (1).
- **Adversarial Testnet Integration Suite**: 5/5 passing (`packages/gateway/testnet_e2e_integration.mjs`), including cross-challenge hash mismatch rejection, requester signature theft rejection, on-chain storage query, double-redemption blocking, and domain-separated proof verification.
- **Total Test Count**: Exactly 47 automated tests (8 Rust + 34 TS/simulation + 5 Testnet E2E).
- **SQLite WAL Durability**: Zero-lock contention under 100 concurrent requests, atomic rollback on duplicate hash collision.
- **Soroban Wasm Target**: Successfully compiled for WebAssembly MVP v1 (`target/wasm32v1-none/release/stellar_x402_contracts.wasm`, 17,421 bytes, SHA-256 matching deployed contract bytecode).
- **Standard Protocol Integration**: Pure JSON-RPC 2.0 (jsonrpc.org) communication with Soroban RPC (Protocol 29 Testnet compatible, zero reliance on private SDK methods).
- **CI/CD Pipeline**: GitHub Actions running on every commit.

---

## 5. Security & Threat Model Defenses

1. **On-Chain Challenge Hash Recomputation (Anti-Griefing)**: The contract computes `compute_challenge_hash(recipient, token, amount, nonce)` on-chain. An attacker attempting to burn an honest payer's challenge by settling 1 stroop or substituting a different recipient generates a completely disjoint hash, leaving the honest payer's receipt slot intact.
2. **Pinned Vault Contract Enforcement**: Gateway parses envelope XDR and validates `invokedContract === targetVault` and `fnName === 'settle_payment'`, failing closed if the envelope is malformed or targets an unauthorized contract.
3. **Domain-Separated Requester Binding**: Proof signature covers `stellar-x402:v1:${networkPassphrase}:${gatewayUrl}:${challengeId}:${txHash}:${expiresAt}` signed with the payer keypair. Observers of the public ledger cannot front-run or steal paid resources without possessing the private key. Contract accounts (`C...`) are cleanly rejected with an actionable error.
4. **Budget In-Flight Overdraft Quarantine**: In-flight transactions are quarantined until `timeBounds.maxTime + 15s` (or 60s default if `maxTime=0`), preventing budget leaks or overdrafts on RPC timeouts.
5. **Contract Immutability & State TTL**: `X402PaymentVault` has zero admin keys and zero upgrade entry points. Persistent receipts are refreshed with `extend_ttl(100k, 500k)` to maintain on-chain audit trails.

---

## 6. Roadmap & Milestones (Forward-Looking Scope)

> **Important**: Milestone 1 was fully completed and verified prior to submission to thoroughly de-risk the technical foundation. The requested $35,000 USD Build Award funds the forward-looking work across Milestones 2 and 3.

### Milestone 1: Core Tooling & Testnet Gateway (Completed Prior to Submission — Self-Funded)
- [x] Monorepo architecture with pnpm workspaces.
- [x] Soroban `X402PaymentVault` contract in Rust with on-chain hash recomputation and anti-replay guarantees.
- [x] HTTP 402 Express middleware and Soroban JSON-RPC 2.0 transaction verifier.
- [x] Autonomous Agent Client SDK with in-flight budget quarantine manager.
- [x] Working MCP server wrapper with paid tool demonstration.

### Milestone 2: Mainnet Hardening, Soroban SAC Token Support & SDK Packaging (Weeks 1 – 4) — $22,000 USD
- [ ] Publish `@stellar-x402/gateway` and `@stellar-x402/client` to npm registry.
- [ ] Multi-asset Soroban Stellar Asset Contract (SAC) routing (USDC, EURC) with slippage bounds.
- [ ] Batch settlement contract for high-frequency agent tool calling (reducing fees by 80%).
- [ ] Formal independent security audit of Soroban `X402PaymentVault` contract for Mainnet deployment ($10,000 allocated).

### Milestone 3: Ecosystem Integrations & Hosted Gateway Directory (Weeks 5 – 8) — $13,000 USD
- [ ] Pre-packaged MCP Server adapters for popular tools (Brave Search, Postgres, GitHub API) ($8,000 allocated).
- [ ] One-click Docker deployment image and Fly.io / Railway templates.
- [ ] Developer portal, interactive sandboxes, hosted testnet RPC relay, and Claude Desktop / LangChain configuration guides ($5,000 allocated).

---

## 7. Budget Request

- **Requested Amount**: $35,000 USD (in XLM)
- **Forward-Looking Allocation**:
  - Independent security audit & Mainnet contract hardening: $10,000
  - Multi-asset SAC router, batch settlement & npm packaging: $12,000
  - Ecosystem MCP adapters (LangChain, Claude Desktop, Docker): $8,000
  - Developer portal, interactive sandboxes & testnet infrastructure: $5,000

---

## 8. Team

- **Carlos Murillo (`camesenin`)**:
  - Full-stack & Web3 engineer.
  - Active contributor to the Stellar / Soroban ecosystem (Drips Wave #1 Global rank, contributor to Meridian, Savitools, and Tansu).
  - Background in systems architecture, TypeScript/Node.js, Rust/Soroban, and AI developer tooling.
