# Drips Stellar Wave — Repository Participation & Curated Backlog

**Repository:** `camesenin/stellar-x402-mcp`  
**Network Program:** Drips Stellar Wave / Stellar Community Fund  
**Audit Baseline Commit:** `9b1d7f9` (v0.2.4-rc1)  
**CI Status:** 100% Green (54 Vitest TS tests + 8 Soroban Rust tests)  

---

## 1. Program Structure & Budget Caps (Exact Arithmetic Match)

Drips allocates point budgets per repository and per organization per Wave. To prevent quota exhaustion or contributor starvation, this backlog is organized into two disciplined tranches of exactly **1,200 points each**:

- **Tranche 1 (Committed Wave 11 Allocation — Exactly 1,200 Points, 8 Issues):** Primary wave allocation fitting standard single-repository budget limits.
- **Tranche 2 (Expansion / Wave 12 Pipeline — Exactly 1,200 Points, 8 Issues):** Unlocked strictly upon Wave Hub budget expansion or carried over to Wave 12.

### Reconciled Complexity Tier Breakdown
| Tier | Points | Count (Tranche 1) | Count (Tranche 2) | Total Issues | Total Points |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Trivial** | 100 | 2 (Issues 1, 2) | 3 (Issues 3, 7, 16) | 5 | 500 pts |
| **Medium** | 150 | 4 (Issues 4, 5, 9, 10) | 2 (Issues 11, 15) | 6 | 900 pts |
| **High** | 200 | 2 (Issues 6, 8) | 3 (Issues 12, 13, 14) | 5 | 1,000 pts |
| **Total** | — | **8 issues (1,200 pts)** | **8 issues (1,200 pts)** | **16 issues** | **2,400 pts** |

*Verification:*  
- Tranche 1: `2 × 100 (200) + 4 × 150 (600) + 2 × 200 (400) = 1,200 pts`  
- Tranche 2: `3 × 100 (300) + 2 × 150 (300) + 3 × 200 (600) = 1,200 pts`  
- Grand Total: `5 × 100 (500) + 6 × 150 (900) + 5 × 200 (1,000) = 2,400 pts` across 16 issues.

---

## 2. Contributor Onboarding, Capacity & Operational SLA

### Maintainer Roles & SLA
- **Primary Maintainer:** Lead Architect (`@camesenin`)
- **Secondary Maintainer:** Protocol Reviewer (`@co-maintainer`)
- **Triage & Assignment:** Issues assigned to contributors within **< 24 hours** of application.
- **Code Review:** PRs reviewed and commented within **< 48 hours**.
- **Max Work-in-Progress (WIP):** Maximum 2 active issues per contributor to prevent hoarding.
- **Stale Assignment Timeout:** If a contributor shows no activity (no draft PR or commit) within **48 hours**, the assignment is revoked and re-opened to community developers.

### Local Development Environment
```bash
# Clone and setup
git clone https://github.com/camesenin/stellar-x402-mcp.git
cd stellar-x402-mcp
pnpm install

# Build contracts and packages
cargo build --target wasm32v1-none --release
pnpm build

# Run test suites
pnpm test
cargo test --package receipt-vault
```

---

## 3. Directed Acyclic Graph (DAG) of Dependencies

The backlog features **12 standalone tasks** with zero blockers, and **4 dependent tasks** with direct technical prerequisites:

```
[Issue 1: CLI Format (100)] -------- (Standalone, 0 deps)
[Issue 2: StrKey Val (100)] -------- (Standalone, 0 deps) --------> [Issue 8: SEP-41 SAC (200)]
[Issue 3: Doctor CLI (100)] -------- (Standalone, 0 deps)
[Issue 4: DB Schema (150)] --------- (Standalone, 0 deps) --------> [Issue 6: PG Store (200)] --------> [Issue 13: Reconciler (200)]
[Issue 5: Settle Tests (150)] ------ (Standalone, 0 deps) --------> [Issue 12: Beneficiary C.. (200)]
[Issue 7: Nanoid/CorrId (100)] ----- (Standalone, 0 deps)
[Issue 9: LangGraph Ex (150)] ------ (Standalone, 0 deps)
[Issue 10: Standalone CI (150)] ---- (Standalone, 0 deps)
[Issue 11: Rate Limiter (150)] ----- (Standalone, 0 deps)
[Issue 14: MCP Stream (200)] ------- (Standalone, 0 deps)
[Issue 15: Prometheus (150)] ------- (Standalone, 0 deps)
[Issue 16: Fast-Check Fuzz (100)] -- (Standalone, 0 deps)
```
- Standalone issues (12 tasks): 1, 2, 3, 4, 5, 7, 9, 10, 11, 14, 15, 16.
- Dependent issues (4 tasks): 6 (requires 4), 8 (requires 2), 12 (requires 5), 13 (requires 6).

---

## 4. Curated Backlog Specification

### TRANCHE 1: COMMITTED WAVE 11 (8 Issues — Exactly 1,200 Points)

#### Issue 1: Add `--format json|table` CLI Output Formatting
- **Tier:** Trivial (100 pts)
- **Target File:** `packages/cli/src/output.ts` (new file), `packages/cli/src/index.ts`
- **Prerequisites:** None
- **Scope:** Add `--format json` and `--format table` options to `x402-stellar balance` and `x402-stellar pay`. Structured JSON writes to `stdout`; error diagnostics write to `stderr`. Exit code `0` on success, `1` on error.
- **Verification Command:** `pnpm --filter @stellar-x402/cli test`

#### Issue 2: StrKey Address Validation with Network & Type Verification
- **Tier:** Trivial (100 pts)
- **Target File:** `packages/client/src/validators/strkey.ts`
- **Prerequisites:** None
- **Scope:** Validate StrKey checksum and encode version byte. Distinguish account public keys (`G...`) from contract IDs (`C...`). Reject invalid checksums and malformed lengths before network dispatch.
- **Verification Command:** `pnpm --filter @stellar-x402/client test`

#### Issue 4: PostgreSQL 16 Idempotent Migration Script
- **Tier:** Medium (150 pts)
- **Target Files:** `packages/gateway/migrations/001_initial.sql`, `packages/gateway/src/scripts/migrate.ts`
- **Prerequisites:** None
- **Scope:** Provide SQL schema with `challenges` table: `id TEXT PRIMARY KEY`, `payer TEXT`, `beneficiary TEXT`, `amount NUMERIC(38, 0)`, `bound_tx_hash TEXT UNIQUE`, `status TEXT`, `lease_owner TEXT`, `lease_expires_at TIMESTAMPTZ`, `lease_generation BIGINT DEFAULT 0`. Migration script must run idempotently (`IF NOT EXISTS`).
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 5: Contract Settlement Semantic Assertions & Event Parsing
- **Tier:** Medium (150 pts)
- **Target File:** `contracts/receipt-vault/tests/settlement_semantics.rs`
- **Prerequisites:** None
- **Scope:** Add unit tests asserting exact event topics `("SETTLE", receipt_id)` and data fields `(payer, beneficiary, amount, token)`. Verify that unauthorized invocations fail and that `Persistent` storage entry TTL is respected.
- **Verification Command:** `cargo test --package receipt-vault --test settlement_semantics`

#### Issue 6: `PostgresChallengeStore` Implementation with Fencing Tokens
- **Tier:** High (200 pts)
- **Target File:** `packages/gateway/src/stores/postgres.ts`
- **Prerequisites:** Issue 4
- **Scope:** Implement `IChallengeStore` against PostgreSQL with `clock_timestamp()` fencing tokens and monotonic `lease_generation`. Prevent concurrent zombie worker overrides.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 8: SEP-0041 SAC Deterministic Address Resolution & Asset Typing
- **Tier:** High (200 pts)
- **Target File:** `packages/client/src/tokens/sac.ts`
- **Prerequisites:** Issue 2
- **Scope:** Resolve Stellar Asset Contract (SAC) address deterministically for Classic assets (`AssetCode:IssuerAccount`). Distinguish between native XLM, issued Classic SAC assets (checking trustlines and issuer), and standalone custom Soroban token contracts.
- **Verification Command:** `pnpm --filter @stellar-x402/client test`

#### Issue 9: LangGraph / LangChain Agent Integration Example
- **Tier:** Medium (150 pts)
- **Target Directory:** `examples/langchain-x402-agent/`
- **Prerequisites:** None
- **Scope:** Provide a complete TypeScript example showing how an autonomous LangGraph agent uses `createX402Fetch` to consume paid MCP tool endpoints.
- **Verification Command:** `pnpm --filter @stellar-x402/example-langchain test`

#### Issue 10: Reusable GitHub Action for Stellar Standalone Testing
- **Tier:** Medium (150 pts)
- **Target File:** `.github/workflows/stellar-standalone.yml`
- **Prerequisites:** None
- **Scope:** Composite action that launches `stellar/quickstart:latest` in standalone mode, waits for ledger close, and executes an end-to-end payment test.
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
- **Target File:** `contracts/receipt-vault/src/lib.rs`
- **Prerequisites:** Issue 5
- **Scope:** Decouple `payer` (who authorizes the transfer) from `beneficiary` (the agent receiving the resource access), allowing smart contracts (`C...`) to pay on behalf of agents.
- **Verification Command:** `cargo test --package receipt-vault`

#### Issue 13: Asynchronous Reconciliation Worker for Interrupted Challenges
- **Tier:** High (200 pts)
- **Target File:** `packages/gateway/src/workers/reconciler.ts`
- **Prerequisites:** Issue 6
- **Scope:** Background reconciler for challenges left in `RECONCILIATION_REQUIRED`. Polls Soroban RPC `getTransaction`; if outside retention window, queries Horizon ledger history. Sets `INCONCLUSIVE_MANUAL_REVIEW` to lock the challenge and prevent double settlement if ambiguous.
- **Verification Command:** `pnpm --filter @stellar-x402/gateway test`

#### Issue 14: MCP Streamable HTTP Transport (Spec 2025-11-25)
- **Tier:** High (200 pts)
- **Target File:** `packages/gateway/src/transports/streamable-http.ts`
- **Prerequisites:** None
- **Scope:** Support Streamable HTTP transport conforming to MCP 2025-11-25. Validates `Origin` header (HTTP 403 on invalid origin if present) to protect against DNS rebinding. HTTP 405 on GET if stream is not offered. Enforces durable challenge idempotency across reconnections.
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
