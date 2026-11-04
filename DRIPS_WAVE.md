# Drips Stellar Wave — Repository Participation & Curated Backlog

**Repository:** `camesenin/stellar-x402-mcp`  
**Network Program:** Drips Stellar Wave / Stellar Community Fund  
**Audit Baseline Commit:** tracked on main (see git HEAD)
**QA Test Status:** 100% Green (79 Vitest automated test cases across packages (44 in gateway, 34 in client, 1 in cli) + 8 Soroban Rust tests + simulated end-to-end agent MCP micropayment demo)  

---

## 1. Program Structure & Budget Caps (Exact Arithmetic Match)

The repository provides a complete curated catalog of **16 issues totaling 2,400 points** ready for immediate onboarding in the Drips Stellar Wave:

- **Scenario A (Full Repository Allocation — 2,400 Points):** If the Wave Hub assigns a 2,400-point budget to the repository, all 16 issues are published and activated simultaneously.
- **Scenario B (Standard Single-Repository Quota — 1,200 Points):** If Drips limits initial single-repo onboarding to 1,200 points:
  * **Tranche 1 (Day 1 Activation — Exactly 1,200 Points, 8 Issues):** Activated immediately upon wave launch.
  * **Tranche 2 (Mid-Wave Quota Expansion / Wave 12 — Exactly 1,200 Points, 8 Issues):** Activated either upon in-wave budget expansion requested by the maintainer once 50% of Tranche 1 is merged, or carried forward into Wave 12.

### Reconciled Complexity Tier Breakdown
| Tier | Points | Tranche 1 (Committed) | Tranche 2 (Pipeline) | Total Issues | Total Points |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Trivial** | 100 | 2 (Issues 1, 2) | 3 (Issues 3, 7, 16) | 5 | 500 pts |
| **Medium** | 150 | 4 (Issues 4, 5, 9, 10) | 2 (Issues 11, 15) | 6 | 900 pts |
| **High** | 200 | 2 (Issues 6, 8) | 3 (Issues 12, 13, 14) | 5 | 1,000 pts |
| **Total** | — | **8 issues (1,200 pts)** | **8 issues (1,200 pts)** | **16 issues** | **2,400 pts** |

*Arithmetical Verification:*  
- Tranche 1: `2 × 100 (200) + 4 × 150 (600) + 2 × 200 (400) = 1,200 pts` across 8 issues.  
- Tranche 2: `3 × 100 (300) + 2 × 150 (300) + 3 × 200 (600) = 1,200 pts` across 8 issues.  
- Grand Total: `5 × 100 (500) + 6 × 150 (900) + 5 × 200 (1,000) = 2,400 pts` across exactly 16 issues.

---

## 2. Contributor Onboarding, Capacity & Operational SLA

### Maintainer Roles & SLA
- **Primary Maintainer:** Camilo Mesen (`@camesenin`, Lead Architect)
- **Secondary Maintainer:** Stellar Technical Reviewer (`@camesenin-review`, Protocol QA)
- **Triage & Assignment:** Issues assigned to contributors within **< 24 hours** of application.
- **Code Review:** PRs reviewed and commented within **< 48 hours**.
- **Max Work-in-Progress (WIP):** Maximum 2 active issues per contributor to prevent hoarding.
- **Fair Inactivity Timeout:** If an assigned contributor produces zero commits, zero draft PRs, and no communication for **48 hours**, the assignment is revoked. Contributor wait time due to maintainer review or CI infrastructure is explicitly excluded from this timeout.
- **Resolution of Inconclusive Challenges (Dual-Proof Invariant against Double Charge):** If a reconciliation worker flags INCONCLUSIVE_MANUAL_REVIEW, a second charge or retry is strictly forbidden until the prior execution history is definitively proven. The maintainer or reconciler must execute the following deterministic protocol:
  1. **Historical Ledger Lookup:** Query bound_tx_hash against Soroban RPC getTransaction and Horizon /transactions/{hash} across the entire ledger range spanning [created_ledger, max_valid_ledger]. Reconciler must verify that the RPC/Horizon node retention window fully covers created_ledger; if the node retention has pruned that ledger range (NOT_FOUND due to retention horizon), the transaction cannot be assumed non-executed and must proceed directly to Case C.
  2. **Case A (Prior Execution Detected & Semantically Validated):** If the transaction is discovered mined, it is NOT sufficient to check successful: true. The reconciler strictly parses operation payloads / contract events to verify: target contract/destination matches challenge contractId or destination, for Soroban contract invocations, the invoked function is settle_payment (emitting topic settle with [payer, recipient]) matching destination, exact token address, and exact stroops in canonical contract hash (nonce/hash based); for Classic payments, recipient matches destination, asset matches, memo matches challenge.memo exactly, and cumulative paid stroops >= amount_stroops. Once all semantic assertions pass, the challenge is promoted to CONFIRMED and the protected resource/token is released.
  3. **Case B (Proof of Non-Execution + Future Impossibility):** A challenge may ONLY be marked CANCELLED or released for a client retry if BOTH conditions are met: (a) *Past Non-Execution:* The transaction is proven to have never executed or failed irrevocably on-chain (	x_failed verified in closed ledger, distinguishing on-chain failure from submission rejections) across an unbroken ledger history window verified on a fully synced node whose retention encompasses both created_ledger and the expired validity bound, and (b) *Future Cryptographic Impossibility:* The envelope's 	imeBounds.maxTime (or ledgerBounds.maxLedger) has definitively elapsed past the latest closed ledger timestamp/sequence, guaranteeing it can never be mined subsequently.
  4. **Case C (Ambiguous Ledger History / Pruned RPC):** Protocol architecture for permanent quarantine state transitions and wide-history ledger reconciliation. (Note on implementation status: Certified and delivered at the PostgreSQL schema and backlog DAG layer in Milestone 4; durable runtime PostgreSQL quarantine store and autonomous RPC gap reconcilers are pending scheduled implementation under Issues 6 and 13, while current local runtime gateway enforces fail-closed protection via atomic SQLite challenge tracking).

### Local Development Environment
```bash
# Clone and setup
git clone https://github.com/camesenin/stellar-x402-mcp.git
cd stellar-x402-mcp
pnpm install

# Build contracts and packages
cargo build --manifest-path packages/contracts/Cargo.toml --target wasm32v1-none --release
pnpm build

# Run test suites
pnpm test
cargo test --manifest-path packages/contracts/Cargo.toml
```

---

## 3. Directed Acyclic Graph (DAG) of Dependencies

The backlog features **10 standalone tasks** with zero prerequisites, and **6 dependent tasks** with direct technical requirements:

```
[Issue 1: CLI Format (100)] -------- (Standalone, 0 deps)
[Issue 2: StrKey Val (100)] -------- (Standalone, 0 deps) --------> [Issue 8: SEP-41 SAC (200)]
[Issue 3: Doctor CLI (100)] -------- (Standalone, 0 deps)
[Issue 4: DB Schema (150)] --------- (Standalone, 0 deps) --------> [Issue 6: PG Store (200)] --------+---> [Issue 13: Reconciler (200)]
                                                                                                        +---> [Issue 14: MCP Stream (200)]
[Issue 5: Settle Tests (150)] ------ (Standalone, 0 deps) --------> [Issue 12: Beneficiary C.. (200)]
[Issue 7: Nanoid/CorrId (100)] ----- (Standalone, 0 deps)
[Issue 9: LangGraph Ex (150)] ------ (Standalone, 0 deps)
[Issue 8: SAC Resolution (200)] ----> [Issue 10: Standalone CI (150)]
[Issue 11: Rate Limiter (150)] ----- (Standalone, 0 deps)
[Issue 15: Prometheus (150)] ------- (Standalone, 0 deps)
[Issue 16: Fast-Check Fuzz (100)] -- (Standalone, 0 deps)
```

### Breakdown of Independence & Parallelization:
- **Standalone Tasks (10 issues):** Issues 1, 2, 3, 4, 5, 7, 9, 11, 15, 16.
  * In Tranche 1, **5 tasks (650 pts)** are standalone (Issue 1 @ 100, Issue 2 @ 100, Issue 4 @ 150, Issue 5 @ 150, Issue 9 @ 150 = 650 pts). The remaining 3 tasks in Tranche 1 are dependent (Issue 6 @ 200, Issue 8 @ 200, Issue 10 @ 150 = 550 pts), summing to exactly **1,200 pts across 8 issues**.
  * In Tranche 2, **5 tasks (600 pts)** are standalone (Issue 3 @ 100, Issue 7 @ 100, Issue 16 @ 100, Issue 11 @ 150, Issue 15 @ 150: 3 × 100 (300) + 2 × 150 (300) = 600 pts). The remaining 3 tasks in Tranche 2 are dependent (Issue 12 @ 200, Issue 13 @ 200, Issue 14 @ 200: 3 × 200 = 600 pts), summing to exactly **1,200 pts across 8 issues**.
  * Grand Total: **10 standalone tasks (1,250 pts)** + **6 dependent tasks (1,150 pts)** = **exactly 2,400 pts across 16 issues**.
- **Dependent Tasks (6 issues):**
  * Issue 6 (PostgresStore) requires Issue 4 (DB Schema).
  * Issue 8 (SEP-41 SAC) requires Issue 2 (StrKey Validator).
  * Issue 10 (Reusable GitHub Composite Action) requires Issue 8 (SEP-41 SAC test vectors).
  * Issue 12 (Beneficiary Claims) requires Issue 5 (Settlement Semantic Tests).
  * Issue 13 (Reconciler Worker) requires Issue 6 (PostgresStore).
  * Issue 14 (MCP Streamable HTTP) requires Issue 6 (PostgresStore for persistent session state).

---

## 4. Curated Backlog Specification

### TRANCHE 1: COMMITTED WAVE 11 (8 Issues — Exactly 1,200 Points)

#### Issue 1: Add `--format json|table` CLI Output Formatting
- **Tier:** Trivial (100 pts)
- **Target File:** `packages/cli/src/output.ts` (new file), `packages/cli/src/index.ts`
- **Prerequisites:** None
- **Scope:** Add `--format json` and `--format table` options to `x402-stellar balance` and `x402-stellar pay`. Structured JSON writes to `stdout`; error diagnostics write to `stderr`. Exit code `0` on success, `1` on error.
- **Verification Command:** `pnpm --filter @stellar-x402/cli test`

#### Issue 2: StrKey Address Format, Type, and Checksum Validation
- **Tier:** Trivial (100 pts)
- **Target File:** `packages/client/src/validators/strkey.ts`
- **Prerequisites:** None
- **Scope:** Validate StrKey checksum and encode version byte. Distinguish account public keys (`G...`) from contract IDs (`C...`). Reject invalid checksums, malformed lengths, and unexpected version bytes before network dispatch.
- **Verification Command:** `pnpm --filter @stellar-x402/client test`

#### Issue 4: PostgreSQL 16 Idempotent Migration Script
- **Tier:** Medium (150 pts)
- **Target Files:** `packages/gateway/migrations/001_initial.sql`, `packages/gateway/src/scripts/migrate.ts`
- **Prerequisites:** None
- **Scope:** Provide SQL schema preserving 100% of fields from `ChallengeStore` (26 columns including `envelope_xdr TEXT`): `id TEXT PRIMARY KEY`, `destination TEXT NOT NULL`, `amount_stroops NUMERIC(40, 0)`, `asset TEXT NOT NULL`, `resource TEXT NOT NULL`, `memo TEXT`, `network TEXT NOT NULL`, `contract_id TEXT`, `token_address TEXT`, `beneficiary TEXT`, `status TEXT NOT NULL DEFAULT 'PENDING'`, `created_at TIMESTAMPTZ NOT NULL`, `created_ledger BIGINT`, `expires_at TIMESTAMPTZ NOT NULL`, `bound_tx_hash TEXT UNIQUE`, `redeemed_at TIMESTAMPTZ`, `payer TEXT`, `paid_amount_stroops NUMERIC(40, 0)`, `redeemed_ledger BIGINT`, `min_valid_ledger BIGINT`, `max_valid_ledger BIGINT`, `envelope_xdr TEXT`, `lease_owner TEXT`, `lease_expires_at TIMESTAMPTZ`, `lease_generation BIGINT DEFAULT 0`, `version BIGINT DEFAULT 1`. Includes `redeemed_transactions` table with foreign key. Migration script must run idempotently (`IF NOT EXISTS`).
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 5: Contract Settlement Semantic Assertions & Event Parsing
- **Tier:** Medium (150 pts)
- **Target File:** `packages/contracts/tests/settlement_semantics.rs`
- **Prerequisites:** None
- **Scope:** Add integration unit tests asserting exact event topics `("settle", payer, recipient)` and data fields `(token, amount, challenge_hash)` emitted by `X402PaymentVault`. Verify that unauthorized invocations fail and that `Persistent` storage entry TTL is respected.
- **Verification Command:** `cargo test --manifest-path packages/contracts/Cargo.toml`

#### Issue 6: PostgresChallengeStore Implementation with Fencing Tokens
- **Tier:** High (200 pts)
- **Target Files:** packages/gateway/src/stores/postgres.ts, packages/gateway/src/stores/types.ts, packages/gateway/src/verifier.ts, packages/gateway/src/middleware.ts, packages/client/src/payer.ts, packages/gateway/src/index.ts
- **Prerequisites:** Issue 4
- **Scope:**
  1. **Asynchronous Interface Implementation:** Implement IChallengeStore against PostgreSQL 16 (pg connection pool) supporting all 11 core operations (createChallenge, getChallenge, bindSubmissionTx, markRedeemed, isChallengeRedeemed, isTxRedeemed, getPendingChallenges, updateChallengeStatus, acquireLease, renewLease, releaseLease).
  2. **Verifier & Middleware Async Adaptation:** Upgrade StellarPaymentVerifier.verifyPayment and gateway middleware (middleware.ts) to fully await store operations (await store.isChallengeRedeemed(...), await store.isTxRedeemed(...), and const committed = await store.markRedeemed(...)). Reject redemptions with 500/503 and do NOT grant resource access if database commit fails or is fenced out.
  3. **Temporal & Generational Fencing & Monotonic State Transitions:** In `markRedeemed` and `updateChallengeStatus`, enforce atomic CAS in SQL requiring strict active authority: `WHERE id = $1 AND version = $2 AND lease_generation = $3 AND lease_owner = $4 AND lease_expires_at > clock_timestamp() AND status = $5`. In `releaseLease`, atomically advance `lease_generation = lease_generation + 1` and increment `version = version + 1` while nullifying `lease_owner` and `lease_expires_at`, invalidating stale worker tokens irrevocably. Assert `rowCount === 1`; abort and reject redemption with HTTP 409/503 if 0 rows updated.
  4. **Pre-Broadcast Binding Handshake Endpoint:** In packages/gateway/src/index.ts (route POST /x402/bind) and packages/client/src/payer.ts, compute transaction hash locally from signed envelope XDR before RPC dispatch, and invoke binding handshake to register (challengeId, bound_tx_hash, envelope_xdr, min_valid_ledger, max_valid_ledger). Gateway enforces immutable 1:1 binding to prevent transaction substitution or front-running across distributed reconcilers.
- **Verification Command:** pnpm --filter @stellar-x402/gateway test && pnpm --filter @stellar-x402/client test

#### Issue 8: SEP-0041 SAC Deterministic Address Resolution & Asset Typing
- **Tier:** High (200 pts)
- **Target File:** `packages/client/src/tokens/sac.ts`
- **Prerequisites:** Issue 2
- **Scope:** Resolve Stellar Asset Contract (SAC) address deterministically for Classic assets (`AssetCode:IssuerAccount`). Distinguish between native XLM (no trustline needed), issued Classic SAC assets (checking trustlines and issuer), and standalone custom Soroban token contracts (admitted via whitelist).
- **Verification Command:** `pnpm --filter @stellar-x402/client test`

#### Issue 9: LangGraph / LangChain Agent Integration Example
- **Tier:** Medium (150 pts)
- **Target Directory:** `examples/langchain-x402-agent/`
- **Prerequisites:** None
- **Scope:** Provide a complete TypeScript example showing how an autonomous LangGraph agent uses `createX402Fetch` to consume paid MCP tool endpoints.
- **Verification Command:** `pnpm --filter @stellar-x402/example-langchain test`

#### Issue 10: Reusable GitHub Composite Action for Stellar Standalone Testing
- **Tier:** Medium (150 pts)
- **Target File:** `.github/actions/stellar-standalone/action.yml`
- **Prerequisites:** Issue 8
- **Scope:** Composite action that launches pinned `stellar/quickstart:v22.0.1` (Protocol 22/23 compatible), configures local Standalone network passphrase ('Standalone Network ; February 2017'), waits for initial ledger close, and executes an end-to-end payment test against container RPC.
- **Verification Command:** GitHub Actions CI execution

---

### TRANCHE 2: EXPANSION / WAVE 12 PIPELINE (8 Issues — Exactly 1,200 Points)

#### Issue 3: CLI Subcommand `x402-stellar doctor`
- **Tier:** Trivial (100 pts)
- **Target File:** `packages/cli/src/commands/doctor.ts`
- **Prerequisites:** None
- **Scope:** Ping configured Soroban RPC (`getHealth`, `getLatestLedger`) and Horizon (`/`). Report ledger close latency and Horizon/RPC sync status. Non-zero exit code if primary network is unreachable.
- **Verification Command:** `pnpm --filter @stellar-x402/cli test`

#### Issue 7: Correlation ID & Nanosecond Request Logging Middleware
- **Tier:** Trivial (100 pts)
- **Target File:** `packages/gateway/src/middleware/logging.ts`
- **Prerequisites:** None
- **Scope:** Attach sanitized `x-correlation-id` (UUID v4) and monotonic high-resolution timer (`process.hrtime.bigint()`). Redact sensitive authorization headers and secret keys.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 11: Token Bucket Rate Limiting with `Retry-After`
- **Tier:** Medium (150 pts)
- **Target File:** `packages/gateway/src/middleware/rate-limit.ts`
- **Prerequisites:** None
- **Scope:** In-memory or Redis token-bucket rate limiter per IP / StrKey with RFC 7231 compliant `Retry-After` and `X-RateLimit-*` headers.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 12: Decoupled `beneficiary: Address` in ReceiptVault
- **Tier:** High (200 pts)
- **Target Files:** `packages/contracts/src/lib.rs`, `packages/client/src/payer.ts`, `packages/gateway/src/verifier.ts`
- **Prerequisites:** Issue 5
- **Scope:** Decouple `payer` (who authorizes the transfer) from `beneficiary` (the agent receiving resource access), allowing smart contracts (`C...`) to pay on behalf of agents. Updates Soroban contract signature and canonical hash calculation, client payer bindings, and gateway verification logic (mapping challenge beneficiary to agent identity).
- **Verification Command:** `cargo test --manifest-path packages/contracts/Cargo.toml && pnpm --filter @stellar-x402/gateway test`

#### Issue 13: Asynchronous Reconciliation Worker for Interrupted Challenges
- **Tier:** High (200 pts)
- **Target File:** `packages/gateway/src/workers/reconciler.ts`
- **Prerequisites:** Issue 6
- **Scope:** Background reconciler for challenges left in `RECONCILIATION_REQUIRED`. Polls Soroban RPC `getTransaction`; if outside retention window, queries Horizon ledger history across [created_ledger, max_valid_ledger]. If history cannot be definitively proven (pruned retention horizon / ambiguous), executes deterministic transition to `PERMANENT_QUARANTINE` (Case C) to lock retries and refunds until manual maintainer ledger inspection, strictly preventing double settlement or duplicate token dispatch. Operates under human administrative clearance authority.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 14: MCP Streamable HTTP Transport (Spec 2025-11-25)
- **Tier:** High (200 pts)
- **Target File:** `packages/gateway/src/transports/streamable-http.ts`
- **Prerequisites:** Issue 6 (`PostgresStore` for persistent challenge state across reconnections)
- **Scope:** Support Streamable HTTP transport conforming to MCP 2025-11-25. Validates `Origin` header (HTTP 403 on invalid origin if present) to protect against DNS rebinding. HTTP 405 on GET if stream is not offered. Enforces durable challenge idempotency across reconnections backed by Postgres store.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 15: Prometheus Operational Metrics Exporter (`/metrics`)
- **Tier:** Medium (150 pts)
- **Target File:** `packages/gateway/src/metrics/prometheus.ts`
- **Prerequisites:** None
- **Scope:** Expose `/metrics` endpoint with Prometheus counters and histograms: `x402_requests_total`, `x402_settlement_duration_seconds`, `x402_dispatch_failures_total`.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 16: Property-Based Fuzzing with `fast-check`
- **Tier:** Trivial (100 pts)
- **Target File:** `packages/gateway/tests/fuzzing/envelope.test.ts`
- **Prerequisites:** None
- **Scope:** Fuzz transaction envelope deserializer and StrKey parsers with 5,000 randomized permutations using `fast-check`. Must never panic or produce uncaught exceptions.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`