# `stellar-x402-mcp`

> **Stellar Agent Gateway & HTTP 402 Micropayment Facilitator for Model Context Protocol (MCP)**

[![CI](https://github.com/camesenin/stellar-x402-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/camesenin/stellar-x402-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Soroban: SDK 22](https://img.shields.io/badge/Soroban_SDK-v22.0.0-purple.svg)](https://soroban.stellar.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-1.6.0-green.svg)](https://modelcontextprotocol.io/)

Autonomous AI agents (running on Claude Desktop, Cursor, Antigravity, or custom LLM frameworks) cannot easily use traditional credit cards or monthly SaaS subscriptions to pay for API resources, live compute, and agent tools. 

`stellar-x402-mcp` is developer infrastructure that brings machine-to-machine micropayments to life using **HTTP 402 Payment Required** and **Stellar / Soroban**.

---

## ⚡ Why Stellar for Autonomous Agent Payments?

| Feature | Stellar / Soroban | Ethereum L1 / L2 | Credit Cards / Stripe |
| :--- | :--- | :--- | :--- |
| **Transaction Cost** | **~$0.00001 (100 stroops)** | $0.05 – $5.00+ | $0.30 + 2.9% minimum |
| **Settlement Finality** | **3 – 5 seconds** | 12s – 15m | 2 – 3 business days |
| **Native Anti-Replay** | **Ledger Memos & Soroban Nonces** | Calldata inspection | Manual authorization ID |
| **Micro-denomination** | **Sub-cent fractions viable** | Impractical due to gas | $0.50 minimum charge |
| **Zero-KYC Machine Auth** | **Native Keypairs** | Smart Accounts / Bundlers | Requires corporate entity |

---

## 🏗️ Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Agent as Autonomous AI Agent
    participant MCP as MCP Client / Fetch
    participant Gateway as Stellar x402 Gateway
    participant Horizon as Stellar Horizon / Soroban RPC
    participant API as MCP Tool / Protected API

    Agent->>MCP: Call tool: generate_market_alpha({symbol: "XLM"})
    MCP->>Gateway: POST /tools/call (No payment proof)
    Gateway-->>MCP: HTTP 402 Payment Required (Challenge ID, Destination, Amount, Memo)
    MCP->>MCP: Verify cost against local Budget Policy (<= 1.0 XLM)
    MCP->>Horizon: Sign & Submit Stellar Payment (XLM/USDC + Memo: ChallengeID)
    Horizon-->>MCP: TxHash confirmed in closed ledger
    MCP->>Gateway: POST /tools/call (_x402_tx_hash, _x402_challenge_id)
    Gateway->>Horizon: Verify TxHash (Destination, Amount, Memo, Anti-Replay check)
    Horizon-->>Gateway: Confirmed valid & unredeemed
    Gateway->>API: Execute Tool Logic
    API-->>Gateway: Result Payload
    Gateway-->>MCP: 200 OK + Tool Output + Settlement Receipt
    MCP-->>Agent: AI Receives Tool Data transparently
```

---

## 📦 Monorepo Structure

```
stellar-x402-mcp/
├── packages/
│   ├── contracts/   # Soroban Rust smart contract (ReceiptVault with anti-replay)
│   ├── gateway/     # Express middleware & MCP Server with 402 enforcement
│   ├── client/      # Autonomous Agent SDK with automated 402 budget negotiation
│   └── cli/         # `x402-stellar` CLI: keygen, gateway, verify, pay
├── examples/
│   └── mcp-payment-demo/ # Full end-to-end runnable agent payment simulation
└── .github/workflows/ci.yml # Continuous Integration (Contracts + TS)
```

---

## 🚀 Quickstart

### 1. Installation

```bash
git clone https://github.com/camesenin/stellar-x402-mcp.git
cd stellar-x402-mcp
pnpm install
pnpm build
```

### 2. Generate and Fund Agent Keypair (Testnet)

```bash
pnpm --filter @stellar-x402/cli run build
node packages/cli/dist/bin.js keygen --fund
```

Output:
```
✨ New Stellar Keypair Generated:
Public Key:  GAUTONOMOUS...
Secret Key:  SSECRETKEY...
✓ Friendbot funded account successfully with 10,000 XLM!
```

### 3. Run the x402 Gateway

Start an HTTP & MCP gateway protecting resources with a fee of `0.01 XLM`:

```bash
node packages/cli/dist/bin.js gateway \
  --port 3402 \
  --dest GA25XQA6A4QGWU566XN6ZCFW3OFH55YOOXWXUYUL2FJ5SO2R6GCCSVKV \
  --amount 0.01 \
  --network testnet
```

### 4. Use the Client in Your Agent Code

```typescript
import { createX402Fetch, ClientConfig } from '@stellar-x402/client';

const config: ClientConfig = {
  secretKey: process.env.STELLAR_AGENT_SECRET!,
  network: 'testnet',
  maxPaymentPerCallXlm: 0.5, // Safety ceiling per call
  totalBudgetLimitXlm: 10.0, // Maximum total spend
};

// Drop-in fetch replacement with automatic Stellar 402 payment handling
const agentFetch = createX402Fetch(config);

// First call gets 402, automatically signs payment, and returns 200 payload
const response = await agentFetch('http://localhost:3402/api/protected-intel');
const data = await response.json();
console.log('Result:', data);
```

### 5. Run the MCP Tool Payment Demo

```bash
pnpm --filter mcp-payment-demo test
```

---

## 🔒 Deployed Soroban Smart Contract (`X402PaymentVault`)

The repository includes a compiled and **on-chain deployed Soroban smart contract** on Stellar Testnet designed for verifiable audit trails and atomic token transfers:

- **Network**: Stellar Testnet
- **Contract ID**: [`CDO7YEKIEYIJ7KV3S4BGIEVNW3JVEGYLV5Q4525LBK2HNUOULFQ3UPL3`](https://stellar.expert/explorer/testnet/contract/CDO7YEKIEYIJ7KV3S4BGIEVNW3JVEGYLV5Q4525LBK2HNUOULFQ3UPL3)
- **Wasm Hash**: `db3c7de9877660a1ad16f3a9ae6ba517e8cfb2b24bdab6e1b3442806ff8935b9` (17,502 bytes, target `wasm32v1-none`)
- **Instantiation Ledger**: `5536798` (TxHash: [`544598a76370b025d329d3e894c4e34444898f1d9088843ddfd9620ff9bde574`](https://stellar.expert/explorer/testnet/tx/544598a76370b025d329d3e894c4e34444898f1d9088843ddfd9620ff9bde574))
- **Verified Settlement Tx**: [`196c89dc9029e1be7a20e09eb47da02e5b7512da53552942b3a0d6f4c918d0b9`](https://stellar.expert/explorer/testnet/tx/196c89dc9029e1be7a20e09eb47da02e5b7512da53552942b3a0d6f4c918d0b9) (Ledger `5536950`)

### Non-Circular Verification
Reviewers can verify bytecode identity dynamically directly from the deployed contract instance on-chain without circular hash assumptions:
```bash
node scripts/verify-contract-bytecode.mjs
```

### Contract Functions:
- `settle_payment(env, payer, recipient, token, amount, nonce: BytesN<32>) -> Result<PaymentReceipt, X402Error>`
- `compute_challenge_hash(env, recipient, token, amount, nonce: BytesN<32>) -> BytesN<32>`
- `is_settled(env, challenge_hash) -> bool`
- `get_receipt(env, challenge_hash) -> Result<PaymentReceipt, X402Error>`
- `total_settlements(env) -> u64`
- **Features**:
  - Cryptographic on-chain calculation of challenge hash ensuring 1-stroop or parameter tampering cannot burn legitimate receipt slots.
  - Cryptographic anti-replay guarantee preventing duplicate challenge claims.
  - Emits `(settle, payer, recipient)` contract event for real-time indexing.
  - Reproducible WebAssembly build (`target/wasm32v1-none/release/stellar_x402_contracts.wasm`, SHA-256 matching deployed bytecode).

### Build and Test Contracts

```bash
cd packages/contracts
cargo test
cargo build --target wasm32v1-none --release
```

---

## 🧪 Testing & Empirical Verification

### 1. Monorepo Test Suite (61 automated tests + 1 integration demo + 5 live on-chain = 67 total verifications)
Run all unit and integration tests across both Rust contracts and TypeScript packages:

```bash
pnpm test
cargo test --manifest-path packages/contracts/Cargo.toml
```

- `@stellar-x402/contracts`: **8 unit tests** (amount > 0 validation, payer auth requirement, insufficient balance rejection, receipt not found handling, happy-path settlement, contract anti-replay panic, multi-challenge isolation, adversarial griefing slot-burning attempt prevention).
- `@stellar-x402/client`: **28 unit & spec tests** (x402 header & JSON parser, concurrency-safe budget reservations, BigInt stroops conversion, fail-closed retention guards for RPC NOT_FOUND, receipt fallback bypassing ledger pruning, active background pool reconciler lifecycle, autonomous key signing with domain separation, and recursive simulation auth tree inspection).
- `@stellar-x402/gateway`: **24 unit tests** (SQLite WAL ACID persistence, atomic rollback on duplicate hash, exact 7-decimal stroop bounds, anti-replay, envelope parameter binding, FeeBump envelope handling, FAILED tx status rejection, pinned vault enforcement, envelope contract whitelisting, smart contract account rejection, deterministic clock rate limiting, anti-spoofing proxy handling, cheap-to-expensive route substitution defense, domain-separated requester signature validation, and retriable HTTP 503 mapping with `Retry-After`).
- `@stellar-x402/cli`: **1 test** (CLI smoke & command validation).
- `examples/mcp-payment-demo`: **1 integration flow** (Full autonomous agent negotiation simulation).

### 2. Live On-Chain Testnet Integration Test (5 adversarial integration tests)
Execute live, end-to-end settlement and adversarial verification against the deployed Soroban contract:

```bash
pnpm --filter @stellar-x402/gateway run test:testnet
```

This automated suite executes:
1. **Challenge Issuance**: Ephemeral merchant issues Challenge A and Challenge B.
2. **On-Chain Settlement**: Ephemeral payer settles Challenge A via Soroban contract `CDO7YEKIEYIJ7KV3S4BGIEVNW3JVEGYLV5Q4525LBK2HNUOULFQ3UPL3` on Protocol 29 Testnet.
3. **Adversarial Envelope Mismatch Test**: Submits TxHash A against Challenge B *before* database redemption; verifier inspects envelope args, detects hash mismatch, and rejects it cleanly.
4. **Adversarial Requester Front-Running Test**: Attacker intercepts Alice's TxHash A on the ledger and attempts redemption with attacker's signature; gateway cryptographically verifies against payer address and rejects claim with 401 Unauthorized.
5. **Legitimate Verification**: Submits TxHash A against Challenge A with Alice's domain-separated signature; verifier validates 4-tuple binding, checks contract persistent storage, and confirms valid settlement.
6. **Anti-Replay Blocking**: Submits TxHash A again to Challenge A; database uniqueness constraint prevents duplicate redemption.
7. **On-Chain Receipt Query**: Confirms storage key `Receipt(challenge_hash)` exists and matches on-chain receipt struct.
8. **Cryptographic Durability Artifact**: Raw RPC response, envelope XDR, and diagnostic events are persisted in [`testnet_evidence_pack.json`](./testnet_evidence_pack.json) to survive Testnet resets.

---

## 🛡️ Threat Model & Security Defenses

| Attack Vector | Vulnerability Scenario | Mitigation Implemented | Tested & Proven In |
| :--- | :--- | :--- | :--- |
| **Griefing / DoS Pre-Consumption** | Attacker grabs public challenge hash from 402 header and settles 1 stroop to attacker address, burning the hash slot. | **On-Chain Hash Recomputation**: Contract computes `SHA256(contract_id \|\| recipient \|\| token \|\| amount \|\| nonce)`. Attacker calling with 1 stroop or different recipient produces a completely disjoint hash, leaving victim's slot untouched. | `packages/contracts/src/lib.rs` (`test_adversarial_griefing_attempt_fails_to_burn_challenge`) |
| **Vault Contract Spoofing** | Attacker deploys malicious contract emitting identical `PaymentReceipt` struct or invoking unauthorized code. | **Pinned Envelope & Storage Contract Whitelisting**: Verifier validates `invokedContract === targetVault` and `fnName === 'settle_payment'` directly from envelope XDR, failing closed if malformed. | `packages/gateway/src/verifier.ts`, `packages/gateway/test/verifier.test.ts` |
| **Redemption Front-Running Race** | Observer spots public confirmed `txHash` on ledger and redeems resource before the legitimate payer. | **Domain-Separated Requester Binding**: Client signs `stellar-x402:v1:${networkPassphrase}:${gatewayUrl}:${challengeId}:${txHash}:${expiresAt}` with the payer keypair. Gateway verifies against `receipt.payer`. Contract accounts (`C...`) are cleanly rejected with actionable errors. | `packages/client/src/payer.ts`, `packages/gateway/src/middleware.ts` |
| **In-Flight Budget Overdraft** | RPC poll times out on network lag; releasing budget immediately allows in-flight tx to land later, exceeding ceiling. | **In-Flight Quarantine & Clock Skew Buffer**: `BudgetManager.release(resId, keepUntilTime)` quarantines reservation until `timeBounds.maxTime + 15s` (or 60s default if `maxTime=0`). | `packages/client/src/budget.ts`, `packages/client/test/budget.test.ts` |
| **State Storage & Immutability** | Soroban persistent entries expire; upgradeable contracts have admin keys. | **Persistent TTL Extension & Zero Admin**: Contract calls `extend_ttl(100k, 500k)` on receipt. Contract has NO admin keys, NO upgrade hooks (immutable bytecode). SQLite WAL provides instant local anti-replay. | `packages/contracts/src/lib.rs` |
| **Rate Limit Evasion via Spoofed IP** | Attacker injects fake `X-Forwarded-For` headers to cycle rate limit buckets. | **Proxy Trust Whitelist & Deterministic Clock**: `trustProxy` setting ignores untrusted proxy headers; `RateLimiter` supports injected clock for deterministic testing. | `packages/gateway/src/middleware.ts`, `packages/gateway/test/middleware.test.ts` |

---

## 🌐 Layer-3 Facilitator Architecture vs Pay-Then-Prove

Standard x402 specifications envision a 3-party protocol: Client, Resource Server, and Facilitator. In high-latency or custodial models, facilitators hold pre-funded credit lines. 

`stellar-x402-mcp` implements a **decentralized Layer-3 Facilitator pattern**:
1. **Resource Server (Gateway)** issues standard `WWW-Authenticate: StellarX402 ...` headers containing pricing and challenge parameters.
2. **Client Agent** signs and submits the transaction directly to Stellar / Soroban without intermediary custodial risk.
3. **Facilitator (Verification Engine)** cryptographically checks on-chain receipts, inspects contract invocation envelopes, and enforces anti-replay via SQLite WAL before delivering protected MCP tool responses.
This gives AI agents complete self-sovereignty without centralized escrow or KYC bottlenecks.

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE).
Copyright 2026 Carlos Murillo (`camesenin`).
