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
- **Deployed Soroban Contract**: Live on Testnet at [`CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA`](https://stellar.expert/explorer/testnet/contract/CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA) (Ledger 5526238, TxHash: `ae152d8104b4e4b8bd100498f7e6245cbd68aecea88eaf5f165f4fc4f7a6e7be`).
- **Live On-Chain Settlement**: Real testnet transaction confirmed at [`700760f41b7266bc50c05e9eb66446433e9c518c120c9352c6adf0e0588bcb24`](https://stellar.expert/explorer/testnet/tx/700760f41b7266bc50c05e9eb66446433e9c518c120c9352c6adf0e0588bcb24) (Ledger `5526687`), transferring native XLM SAC with verified contract receipt.
- **Cryptographic Durability Artifact**: Raw RPC response, envelope XDR, and diagnostic events preserved in [`testnet_evidence_pack.json`](./testnet_evidence_pack.json), ensuring persistent verification immune to Testnet ledger resets.
- **Rust Contract Unit Tests**: 7/7 passing (`packages/contracts/src/lib.rs`), asserting amount validation, payer authorization, insufficient balance checks, receipt retrieval, replay panic, and multi-challenge isolation.
- **TypeScript Test Suite**: 31/31 passing across `@stellar-x402/gateway` (16), `@stellar-x402/client` (13), `@stellar-x402/cli` (1), and `examples/mcp-payment-demo` (1).
- **Adversarial Testnet Integration Suite**: 4/4 passing (`packages/gateway/testnet_e2e_integration.mjs`), including cross-challenge hash mismatch rejection, envelope argument binding, on-chain storage query, and double-redemption blocking.
- **Total Test Count**: Exactly 42 automated tests (7 Rust + 31 TS + 4 Testnet E2E).
- **SQLite WAL Durability**: Zero-lock contention under 100 concurrent requests, atomic rollback on duplicate hash collision.
- **Soroban Wasm Target**: Successfully compiled for WebAssembly MVP v1 (`target/wasm32v1-none/release/stellar_x402_contracts.wasm`, 15,663 bytes).
- **Standard Protocol Integration**: Pure RFC 7159 / JSON-RPC 2.0 communication with Soroban RPC (Protocol 23+ compatible, zero reliance on private SDK methods).
- **CI/CD Pipeline**: GitHub Actions running on every commit.

---

## 5. Security & Threat Model Defenses

1. **Anti-Griefing Parameter Binding**: Challenges commit to `(destination, token, amount, nonce)` in the challenge hash. The gateway enforces full 4-tuple envelope matching (`recipient`, `token`, `amount_stroops`, `challenge_hash`). An attacker attempting to burn a challenge with 1 stroop to an arbitrary address is strictly rejected.
2. **Pinned Vault Contract Enforcement**: Gateway verifies `contractId` against `pinnedVaultContractId`, rejecting spoofed contract instances.
3. **Redemption Front-Running Mitigation**: Cryptographic signature validation (`X-Payer-Signature`) binds `${challengeId}:${txHash}` to the payer keypair. Public ledger observers cannot front-run or steal paid resources without possessing the private key.
4. **Budget In-Flight Overdraft Quarantine**: In-flight transactions are quarantined until `timeBounds.maxTime` has elapsed, preventing budget leaks or overdrafts on RPC timeouts.
5. **Contract Immutability & State TTL**: `X402PaymentVault` has zero admin keys and zero upgrade entry points. Persistent receipts are refreshed with `extend_ttl(100k, 500k)` to maintain on-chain audit trails.

---

## 6. Roadmap & Milestones (Forward-Looking Scope)

> **Important**: Milestone 1 was fully completed and verified prior to submission to thoroughly de-risk the technical foundation. The requested $35,000 USD Build Award funds the forward-looking work across Milestones 2 and 3.

### Milestone 1: Core Tooling & Testnet Gateway (Completed Prior to Submission — Self-Funded)
- [x] Monorepo architecture with pnpm workspaces.
- [x] Soroban `X402PaymentVault` contract in Rust with anti-replay guarantees.
- [x] HTTP 402 Express middleware and Soroban JSON-RPC 2.0 transaction verifier.
- [x] Autonomous Agent Client SDK with in-flight budget quarantine manager.
- [x] Working MCP server wrapper with paid tool demonstration.

### Milestone 2: Mainnet Hardening, Soroban SAC Token Support & SDK Packaging (Weeks 1 – 4)
- [ ] Publish `@stellar-x402/gateway` and `@stellar-x402/client` to npm registry.
- [ ] Multi-asset Soroban Stellar Asset Contract (SAC) routing (USDC, EURC) with slippage bounds.
- [ ] Batch settlement contract for high-frequency agent tool calling (reducing fees by 80%).
- [ ] Formal independent security audit of Soroban `X402PaymentVault` contract for Mainnet deployment.

### Milestone 3: Ecosystem Integrations & Hosted Gateway Directory (Weeks 5 – 8)
- [ ] Pre-packaged MCP Server adapters for popular tools (Brave Search, Postgres, GitHub API).
- [ ] One-click Docker deployment image and Fly.io / Railway templates.
- [ ] Community developer documentation site with interactive sandboxes.
- [ ] Integration with LangChain / LangGraph and Claude Desktop configuration guides.

---

## 7. Budget Request

- **Requested Amount**: $35,000 USD (in XLM)
- **Forward-Looking Allocation**:
  - Independent security audit & Mainnet contract hardening: $10,000
  - Multi-asset SAC router, batch settlement & npm packaging: $12,000
  - Ecosystem MCP adapters (LangChain, Claude Desktop, Docker): $8,000
  - Developer portal, interactive sandboxes & testnet infrastructure: $5,000

---

## 7. Team

- **Carlos Murillo (`camesenin`)**:
  - Full-stack & Web3 engineer.
  - Active contributor to the Stellar / Soroban ecosystem (Drips Wave #1 Global rank, contributor to Meridian, Savitools, and Tansu).
  - Background in systems architecture, TypeScript/Node.js, Rust/Soroban, and AI developer tooling.
