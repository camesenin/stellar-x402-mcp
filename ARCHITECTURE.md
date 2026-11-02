# `stellar-x402-mcp` Architecture & Technical Specification

## 1. Overview & Protocol Flow

The HTTP 402 ("Payment Required") status code was reserved in RFC 7231 for digital payment systems but remained underutilized due to lack of frictionless micro-settlement infrastructure.

`stellar-x402-mcp` adapts the x402 specification specifically for **Stellar & Soroban**, serving the rapidly expanding ecosystem of autonomous AI agents communicating over the **Model Context Protocol (MCP)**.

---

## 2. Handshake Protocol Specification

### Step 1: Challenge Issuance (Gateway -> Agent)

When an unauthenticated or unpaid request hits a protected resource or MCP tool, the Gateway responds with HTTP 402:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
WWW-Authenticate: StellarX402 challenge_id="a8f09...", destination="GABC...", amount="0.01", asset="XLM", memo="a8f09..."
X-Payment-Address: GABC...
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
    "challengeId": "a8f09...",
    "destination": "GABC...",
    "amount": "0.01",
    "asset": "XLM",
    "memo": "a8f09...",
    "network": "testnet",
    "expiresAt": 1793653344000
  }
}
```

### Step 2: Payment Execution (Agent -> Stellar Ledger)

The agent client parses the challenge, verifies the requested cost against its local policy, and executes a payment:

- **Classic Horizon Path**: Submits a `PaymentOperation` to `challenge.destination` with `Memo.text(challenge.memo)`.
- **Soroban Smart Contract Path**: Calls `X402PaymentVault::settle_payment(payer, destination, token, amount, challenge_hash)`.

### Step 3: Proof Submission (Agent -> Gateway)

The agent repeats the original request, attaching payment proof:

```http
GET /api/resource HTTP/1.1
X-Stellar-TxHash: 11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff
X-Challenge-Id: a8f09...
Authorization: StellarX402 txHash="112233...", challenge_id="a8f09..."
```

### Step 4: Verification & Settlement (Gateway)

The Gateway:
1. Verifies that `X-Stellar-TxHash` is not in its local `redeemedTxHashes` cache.
2. Queries Stellar Horizon / Soroban RPC to confirm transaction confirmation.
3. Validates that `tx.memo == challenge.memo`.
4. Confirms `amount >= challenge.amount` and destination matches.
5. Marks challenge and txHash as redeemed.
6. Returns `200 OK` with header `X-Payment-Settled: true`.

---

## 3. Threat Model & Mitigations

| Threat | Attack Vector | Mitigation Strategy |
| :--- | :--- | :--- |
| **Transaction Replay** | Attacker intercepts a valid `X-Stellar-TxHash` and submits it for subsequent calls. | Each challenge includes an ephemeral cryptographic nonce (`challengeId`) that must match the transaction `Memo`. Both `challengeId` and `txHash` are invalidated upon first redemption. |
| **Price Gouging** | Malicious gateway returns inflated challenge amount (e.g., 500 XLM). | `BudgetManager` on the agent client enforces strict `maxPaymentPerCallXlm` (default: 1.0 XLM) and `totalBudgetLimitXlm`. If violated, the transaction is rejected locally without signing. |
| **Front-Running / Race Conditions** | Third party attempts to claim a transaction hash before the intended client. | Horizon memo links directly to the specific challenge nonce issued to the requesting session. |
| **Stale Transaction Injection** | Submitting a historical transaction from days ago with unrelated memo. | Challenge nonces expire after configured TTL (default 5 minutes). |

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
    challenge_hash: BytesN<32>,
) -> Result<PaymentReceipt, X402Error> {
    payer.require_auth();
    // Replay guard
    let receipt_key = DataKey::Receipt(challenge_hash.clone());
    if env.storage().persistent().has(&receipt_key) {
        return Err(X402Error::AlreadySettled);
    }
    // Token transfer
    let token_client = token::Client::new(&env, &token);
    token_client.transfer(&payer, &recipient, &amount);
    // ...
}
```

This guarantees that settlement is atomic, verifiable by third-party auditors, and indexed via Soroban events.
