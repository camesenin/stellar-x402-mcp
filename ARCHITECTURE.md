# `stellar-x402-mcp` Architecture & Technical Specification

## 1. Overview & Protocol Flow

The HTTP 402 ("Payment Required") status code was reserved in RFC 7231 for digital payment systems but remained underutilized due to lack of frictionless micro-settlement infrastructure.

`stellar-x402-mcp` implements machine-to-machine micropayments for autonomous AI agents consuming **Model Context Protocol (MCP)** tool APIs using **Stellar Classic Payments & Soroban Smart Contracts**.

---

## 2. Handshake Protocol Specification

### Step 1: Challenge Issuance (Gateway -> Agent)

When an unauthenticated or unpaid request hits a protected resource or MCP tool, the Gateway responds with HTTP 402:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
WWW-Authenticate: StellarX402 challenge_id="a8f09...", destination="GDXK...", amount="0.01", asset="XLM", memo="a8f09...", network="testnet", expires_at="1793897410876"
X-Payment-Address: GDXK...
X-Payment-Amount: 0.01
X-Payment-Asset: XLM
X-Payment-Memo: a8f09...
X-Challenge-Id: a8f09...
X-Payment-Network: testnet

{
  "status": 402,
  "error": "Payment Required",
  "protocol": "x402-stellar/1.0",
  "challenge": {
    "challengeId": "a8f09df36f22a2330f7ae92d2639c0cea8f8222c60e77ae5817c6ad39cf65",
    "destination": "GDXK5WSTTUUL5LCTRU47HVOBHY5RMFHRT2KKMGFQHUMTMNO35PD3OEXF",
    "amount": "0.01",
    "asset": "XLM",
    "memo": "a8f09df36f22a2330f7ae92d2",
    "network": "testnet",
    "expiresAt": 1793897410876
  }
}
```

> **Note on Classic Memo**: In the Classic Horizon path, `memo` is a 28-byte hex prefix or `Memo.hash` corresponding to the cryptographic challenge ID to fit within Stellar's 28-byte text memo limit.

### Step 2: Payment Execution (Agent -> Stellar Ledger)

The agent client parses the challenge, validates the requested amount against its local `BudgetManager` policy, and submits payment on-chain:

- **Classic Horizon Path**: Submits a native `PaymentOperation` to `challenge.destination` with `Memo.text(challenge.memo)`.
- **Soroban Smart Contract Path**: Calls `X402PaymentVault::settle_payment(payer, recipient, token, amount, nonce)`.

### Step 3: Proof Submission (Agent -> Gateway)

The agent repeats the request, attaching payment proof and a domain-separated cryptographic signature proving ownership of the payer keypair:

```http
GET /api/resource HTTP/1.1
X-Stellar-TxHash: 196c89dc9029e1be7a20e09eb47da02e5b7512da53552942b3a0d6f4c918d0b9
X-Challenge-Id: a8f09df36f22a2330f7ae92d2639c0cea8f8222c60e77ae5817c6ad39cf65
X-Requester-Signature: base64(ed25519_sign(payer_keypair, message))
Authorization: StellarX402 txHash="196c89...", challenge_id="a8f09..."
```

Where `message` is the canonical domain-separated string:
```text
stellar-x402:v1:${networkPassphrase}:${gatewayUrl}:${challengeId}:${txHash}:${expiresAt}
```

### Step 4: Dual-Layer Verification & Settlement (Gateway)

The Gateway validates the claim using strict dual-layer verification:

1. **Local Anti-Replay Check**: In an atomic SQLite transaction (WAL mode with `IMMEDIATE` transaction locking), checks that `challengeId` is valid, unexpired, and has not yet been marked redeemed.
2. **On-Chain Ledger Verification**:
   - **For Soroban Vault Invocations**:
     - Inspects envelope XDR to verify that the invoked contract matches the pinned `targetVault` contract ID and the method invoked is strictly `settle_payment`.
     - Validates that parameters match: `amount >= challenge.amount`, `recipient == challenge.destination`, and `token == challenge.asset`.
     - Simulates `compute_challenge_hash(recipient, token, amount, nonce)` and verifies on-chain ledger storage `DataKey::Receipt(challenge_hash)` to confirm successful atomic settlement.
   - **For Classic Horizon Payments**:
     - Fetches transaction from Horizon RPC and validates `tx.memo === challenge.memo`.
     - Confirms payment operation destination and amount.
3. **Requester Binding Defense**: Verifies `X-Requester-Signature` using `payerPublicKey` (from on-chain receipt/envelope) against the domain-separated message. This guarantees that an observer who views a transaction on the public ledger cannot front-run or steal the paid session.
4. **Atomic Redemption**: Marks the challenge and transaction hash as redeemed in SQLite.
5. **Resource Release**: Returns `200 OK` with header `X-Payment-Settled: true` and the requested tool output.

---

## 3. Threat Model & Mitigations

| Threat | Attack Vector | Mitigation Strategy | Proven In |
| :--- | :--- | :--- | :--- |
| **Griefing / Pre-Consumption** | Attacker grabs public challenge parameters and settles 1 stroop to burn the receipt slot. | **On-Chain Hash Recomputation**: Contract computes `SHA256(contract_id \|\| recipient \|\| token \|\| amount \|\| nonce)`. An attacker altering amount or recipient produces a completely disjoint hash, leaving victim's slot untouched. | `packages/contracts/src/lib.rs` (`test_adversarial_griefing_attempt_fails_to_burn_challenge`) |
| **Transaction Front-Running** | Observer spots public confirmed `txHash` on the ledger and attempts to claim the API session before the payer. | **Domain-Separated Requester Binding**: Requester must sign `stellar-x402:v1:...` with the on-chain payer's ed25519 keypair. Gateway cryptographically verifies this signature against `receipt.payer`. | `packages/gateway/src/verifier.ts`, `packages/gateway/test/verifier.test.ts` |
| **Contract Vault Spoofing** | Attacker deploys a dummy contract emitting matching receipt structs or mimicking payment calls. | **Pinned Envelope & Storage Contract Whitelisting**: Verifier validates `invokedContract === targetVault` and `fnName === 'settle_payment'` directly from envelope XDR, failing closed if malformed. | `packages/gateway/src/verifier.ts` |
| **Transaction Replay (Double Spend)** | Attacker submits the same `txHash` across multiple requests or gateways. | **Dual Anti-Replay Guard**: SQLite enforces unique index constraint on `redeemed_tx_hash` with `BEGIN IMMEDIATE` locks. On-chain Soroban contract stores `DataKey::Receipt(challenge_hash)` with `AlreadySettled` rejection. | `packages/gateway/src/challenge-store.ts`, `packages/contracts/src/lib.rs` |
| **In-Flight Budget Overdraft** | RPC poll times out on network lag; releasing budget immediately allows in-flight tx to land later, exceeding ceiling. | **In-Flight Quarantine & Clock Skew Buffer**: `BudgetManager.release(resId, keepUntilTime)` quarantines reservation until `timeBounds.maxTime + 15s` (or 60s default). | `packages/client/src/budget.ts`, `packages/client/test/budget.test.ts` |
| **Rate Limit Evasion via Spoofed IP** | Attacker injects fake `X-Forwarded-For` headers to cycle rate limit buckets. | **Proxy Trust Whitelist & Deterministic Clock**: `trustProxy` setting ignores untrusted proxy headers; `RateLimiter` supports injected clock for deterministic testing. | `packages/gateway/src/middleware.ts` |

---

## 4. Soroban Smart Contract Design

The `X402PaymentVault` contract in `packages/contracts/src/lib.rs` provides deterministic on-chain settlement:

```rust
pub fn settle_payment(
    env: Env,
    payer: Address,
    recipient: Address,
    token: Address,
    amount: i128,
    nonce: BytesN<32>,
) -> Result<PaymentReceipt, X402Error> {
    payer.require_auth();

    if amount <= 0 {
        return Err(X402Error::InvalidAmount);
    }

    // Derive canonical challenge hash on-chain from call parameters and nonce
    let challenge_hash = Self::compute_challenge_hash(
        env.clone(),
        recipient.clone(),
        token.clone(),
        amount,
        nonce,
    );

    // Anti-replay: Ensure this canonical challenge hash hasn't already been fulfilled
    let receipt_key = DataKey::Receipt(challenge_hash.clone());
    if env.storage().persistent().has(&receipt_key) {
        return Err(X402Error::AlreadySettled);
    }

    // Perform token transfer from payer to recipient
    let token_client = token::Client::new(&env, &token);
    token_client.transfer(&payer, &recipient, &amount);

    let timestamp = env.ledger().timestamp();
    let receipt = PaymentReceipt {
        payer: payer.clone(),
        recipient: recipient.clone(),
        token: token.clone(),
        amount,
        settled_at: timestamp,
        challenge_hash: challenge_hash.clone(),
    };

    // Store receipt and extend TTL (100,000 threshold, 500,000 ledgers ~ 29 days live window)
    env.storage().persistent().set(&receipt_key, &receipt);
    env.storage().persistent().extend_ttl(&receipt_key, 100_000, 500_000);

    // Emit event for real-time indexers
    env.events().publish((symbol_short!("settle"), payer, recipient), amount);

    Ok(receipt)
}
```

---

## 5. Architectural Boundaries & Operational Scope

1. **Non-Custodial Architecture**: The gateway never holds, escrows, or pools agent funds. Funds transfer atomically from `payer` to `merchant/recipient` on the Stellar ledger.
2. **Gateway Persistence Scope**: The primary replay defense is enforced locally by the API provider's SQLite store (WAL mode, busyTimeout 5000ms). The Soroban on-chain receipt acts as cryptographic audit trail with a bounded TTL extension (up to 500,000 ledgers / ~29 days).
3. **Identity Model**: Requester binding requires standard Stellar ed25519 agent keypairs (`G...`). Smart contract accounts (`C...`) that cannot produce ed25519 signatures are gracefully rejected with descriptive diagnostics.
