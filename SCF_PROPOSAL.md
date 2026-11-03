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
- **Deployed Soroban Contract**: Live on Testnet at [`CDO7YEKIEYIJ7KV3S4BGIEVNW3JVEGYLV5Q4525LBK2HNUOULFQ3UPL3`](https://stellar.expert/explorer/testnet/contract/CDO7YEKIEYIJ7KV3S4BGIEVNW3JVEGYLV5Q4525LBK2HNUOULFQ3UPL3) (Ledger `5536798`, TxHash: [`544598a76370b025d329d3e894c4e34444898f1d9088843ddfd9620ff9bde574`](https://stellar.expert/explorer/testnet/tx/544598a76370b025d329d3e894c4e34444898f1d9088843ddfd9620ff9bde574)).
- **Live On-Chain Settlement**: Real testnet transaction confirmed at [`196c89dc9029e1be7a20e09eb47da02e5b7512da53552942b3a0d6f4c918d0b9`](https://stellar.expert/explorer/testnet/tx/196c89dc9029e1be7a20e09eb47da02e5b7512da53552942b3a0d6f4c918d0b9) (Ledger `5536950`), transferring native XLM SAC with verified contract receipt.
- **Cryptographic Durability Artifact**: Raw RPC response, envelope XDR, and diagnostic events preserved in [`testnet_evidence_pack.json`](./testnet_evidence_pack.json), ensuring persistent verification immune to Testnet ledger resets.
- **Rust Contract Unit Tests**: 8/8 passing (`packages/contracts/src/lib.rs`), asserting amount validation, payer authorization, insufficient balance checks, receipt retrieval, replay panic, multi-challenge isolation, and adversarial griefing slot-burning immunity.
- **TypeScript Test Suite**: 53/53 passing across `@stellar-x402/client` (28), `@stellar-x402/gateway` (24), and `@stellar-x402/cli` (1).
- **Executable Integration Demo**: 1/1 passing (`examples/mcp-payment-demo`).
- **Adversarial Testnet Integration Suite**: 5/5 passing (`packages/gateway/testnet_e2e_integration.mjs`), including cross-challenge hash mismatch rejection, requester signature theft rejection, on-chain storage query, double-redemption blocking, and domain-separated proof verification.
- **Total Test Count**: Exactly 61 automated unit/spec tests (8 Rust + 53 Vitest) + 1 integration demo flow + 5 Testnet E2E live cases = **67 total verifiable assertions**.
- **SQLite WAL Durability**: Zero-lock contention under 100 concurrent requests, atomic rollback on duplicate hash collision.
- **Soroban Wasm Target**: Successfully compiled for WebAssembly target `wasm32v1-none` (`target/wasm32v1-none/release/stellar_x402_contracts.wasm`, 17,502 bytes, SHA-256: `db3c7de9877660a1ad16f3a9ae6ba517e8cfb2b24bdab6e1b3442806ff8935b9`). Toolchain pinned via `packages/contracts/rust-toolchain.toml` and verified via Dockerfile.
- **Non-Circular Bytecode Verifier**: Standalone tool `scripts/verify-contract-bytecode.mjs` verifying contract instance to bytecode parity dynamically from ledger storage.
- **Standard Protocol Integration**: Pure JSON-RPC 2.0 (jsonrpc.org) communication with Soroban RPC (Protocol 29 Testnet compatible, zero reliance on private SDK methods).
- **CI/CD Pipeline**: GitHub Actions running on every commit.

---

## 5. Security & Threat Model Defenses

1. **On-Chain Challenge Hash Recomputation (Anti-Griefing)**: The contract computes `compute_challenge_hash(recipient, token, amount, nonce)` on-chain. An attacker attempting to burn an honest payer's challenge by settling 1 stroop or substituting a different recipient generates a completely disjoint hash, leaving the honest payer's receipt slot intact.
2. **Pinned Vault Contract Enforcement & FeeBump Unpacking**: Gateway parses envelope XDR, unrolls `envelopeTypeTxFeeBump` (`innerTx`), and validates `invokedContract === targetVault` and `fnName === 'settle_payment'`, failing closed if the envelope is malformed or targets an unauthorized contract.
3. **Domain-Separated Requester Binding & Resource Route Pinning**: Proof signature covers `stellar-x402:v1:${networkPassphrase}:${gatewayUrl}:${challengeId}:${txHash}:${expiresAt}` signed with the payer keypair. Resource routes are bound strictly (`challenge.resource === currentResource`), blocking cheap-to-expensive resource substitution with HTTP 403. Contract accounts (`C...`) are cleanly rejected with an actionable error.
4. **Budget In-Flight Overdraft Quarantine & Retention Guards**: In-flight transactions are quarantined with normalized epoch seconds until `timeBounds.maxTime + 15s` (or 60s default if `maxTime=0`). Fail-closed retention guards and on-chain contract receipt queries prevent double spending or budget leaks on RPC timeouts or history pruning.
5. **Contract Immutability & State TTL**: `X402PaymentVault` has zero admin keys and zero upgrade entry points (verified with 25 canonical WASM imports and 7 exports). Persistent receipts are refreshed with `extend_ttl(100k, 500k)` to maintain on-chain audit trails.

---

## 6. Roadmap & Milestones (Forward-Looking Scope)

> **Important**: Milestone 1 was fully completed and verified prior to submission to thoroughly de-risk the technical foundation. The requested $35,000 USD Build Award funds the forward-looking work across Milestones 2, 3, and 4.

### Milestone 1: Core Architecture & Testnet Hardening (Completed Prior to Submission — Self-Funded)
- [x] Monorepo architecture with pnpm workspaces.
- [x] Soroban `X402PaymentVault` contract in Rust with on-chain hash recomputation and anti-replay guarantees.
- [x] HTTP 402 Express middleware and Soroban JSON-RPC 2.0 transaction verifier.
- [x] Autonomous Agent Client SDK with in-flight budget quarantine manager and simulation auth tree verification.
- [x] Working MCP server wrapper with paid tool demonstration and 61 automated unit tests.

### Milestone 2: Feature Freeze & Multi-Token SAC Contracts (Weeks 1 – 4) — $12,000 USD (34%)
- [ ] Multi-asset Soroban Stellar Asset Contract (SAC) routing (USDC, EURC) with slippage bounds.
- [ ] Batch settlement contract for high-frequency agent tool calling (reducing fees by 80%).
- [ ] Smart account (`C...`) redemption via bearer ticket tokens.
- [ ] Multi-token budget pools (`Map<string, bigint>`) with rent reserve accounting.
- [ ] Feature Freeze and monorepo stabilization.

### Milestone 3: Independent Security Audit & Remediation (Weeks 5 – 10, 4–6 weeks) — $10,000 USD (29%)
- [ ] Engagement of external independent cybersecurity audit firm (targeting Cantina, OtterSec, or CertiK) for ~400 LOC of Soroban smart contract and gateway verification code ($10,000 allocation).
- [ ] Formal remediation and mutual sign-off on 100% of Critical, High, and Medium findings.
- [ ] Publication of public audit report by the auditing firm.

### Milestone 4: Mainnet Deployment & Turnkey Ecosystem Tooling (Weeks 11 – 14, 4 weeks) — $13,000 USD (37%)
- [ ] Mainnet deployment of audited `X402PaymentVault`.
- [ ] Publish `@stellar-x402/gateway` and `@stellar-x402/client` to npm registry.
- [ ] Pre-packaged MCP Server adapters for popular tools (Brave Search, Postgres, GitHub API).
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
