#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    token, xdr::ToXdr, Address, Bytes, BytesN, Env, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum X402Error {
    AlreadySettled = 1,
    InvalidAmount = 2,
    NotAuthorized = 3,
    ReceiptNotFound = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentReceipt {
    pub payer: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub timestamp: u64,
    pub challenge_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Receipt(BytesN<32>),
    ReceiptCount,
}

const SETTLE_EVENT: Symbol = symbol_short!("settle");

#[contract]
pub struct X402PaymentVault;

#[contractimpl]
impl X402PaymentVault {
    /// Deterministically derive the canonical 32-byte challenge hash on-chain:
    /// SHA256(contract_address || recipient || token || amount_i128_be || nonce)
    /// Guarantees that any parameter alteration generates a disjoint hash,
    /// mathematically preventing griefing/pre-consumption attacks.
    pub fn compute_challenge_hash(
        env: Env,
        recipient: Address,
        token: Address,
        amount: i128,
        nonce: BytesN<32>,
    ) -> BytesN<32> {
        let contract_id = env.current_contract_address();
        let mut payload = Bytes::new(&env);
        payload.append(&contract_id.to_xdr(&env));
        payload.append(&recipient.to_xdr(&env));
        payload.append(&token.to_xdr(&env));
        let be_bytes = (amount as u128).to_be_bytes();
        let mut amt_sc_bytes = Bytes::new(&env);
        for b in be_bytes.iter() {
            amt_sc_bytes.push_back(*b);
        }
        payload.append(&amt_sc_bytes);
        payload.append(&nonce.to_xdr(&env));
        env.crypto().sha256(&payload).into()
    }

    /// Settle an x402 payment challenge on-chain.
    /// Transfers `amount` of `token` from `payer` to `recipient`,
    /// derives canonical `challenge_hash` internally from call arguments and `nonce`,
    /// verifies anti-replay of `challenge_hash`, stores the receipt,
    /// and emits a `settle` event.
    pub fn settle_payment(
        env: Env,
        payer: Address,
        recipient: Address,
        token: Address,
        amount: i128,
        nonce: BytesN<32>,
    ) -> Result<PaymentReceipt, X402Error> {
        // Payer must authorize this transfer
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
            timestamp,
            challenge_hash: challenge_hash.clone(),
        };

        // Persist receipt with persistent storage TTL
        env.storage().persistent().set(&receipt_key, &receipt);
        env.storage().persistent().extend_ttl(&receipt_key, 100_000, 500_000);

        // Update total receipts counter
        let count_key = DataKey::ReceiptCount;
        let current_count: u64 = env.storage().instance().get(&count_key).unwrap_or(0);
        env.storage().instance().set(&count_key, &(current_count + 1));

        // Emit settlement event for off-chain indexing
        env.events().publish(
            (SETTLE_EVENT, payer, recipient),
            (token, amount, challenge_hash),
        );

        Ok(receipt)
    }

    /// Query whether a given challenge_hash has been settled
    pub fn is_settled(env: Env, challenge_hash: BytesN<32>) -> bool {
        let key = DataKey::Receipt(challenge_hash);
        env.storage().persistent().has(&key)
    }

    /// Retrieve full receipt data for a settled challenge_hash
    pub fn get_receipt(env: Env, challenge_hash: BytesN<32>) -> Result<PaymentReceipt, X402Error> {
        let key = DataKey::Receipt(challenge_hash);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(X402Error::ReceiptNotFound)
    }

    /// Return total number of settled payments processed by this vault
    pub fn total_settlements(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ReceiptCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
    };

    #[test]
    fn test_successful_settlement() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1730000000);

        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin);
        let token_client = StellarAssetClient::new(&env, &token_id.address());
        token_client.mint(&payer, &10_000_000);

        let nonce = BytesN::from_array(&env, &[42u8; 32]);
        let amount = 1_000_000i128; // 0.1 XLM in stroops

        let expected_hash = client.compute_challenge_hash(&recipient, &token_id.address(), &amount, &nonce);

        let receipt = client.settle_payment(
            &payer,
            &recipient,
            &token_id.address(),
            &amount,
            &nonce,
        );

        assert_eq!(receipt.amount, amount);
        assert_eq!(receipt.payer, payer);
        assert_eq!(receipt.recipient, recipient);
        assert_eq!(receipt.challenge_hash, expected_hash);

        // Verification checks
        assert!(client.is_settled(&expected_hash));
        let fetched = client.get_receipt(&expected_hash);
        assert_eq!(fetched, receipt);
        assert_eq!(client.total_settlements(), 1);

        // Balance check
        let token_query = token::Client::new(&env, &token_id.address());
        assert_eq!(token_query.balance(&payer), 9_000_000);
        assert_eq!(token_query.balance(&recipient), 1_000_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_anti_replay_prevents_duplicate_settlement() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin);
        let token_client = StellarAssetClient::new(&env, &token_id.address());
        token_client.mint(&payer, &10_000_000);

        let nonce = BytesN::from_array(&env, &[99u8; 32]);

        // First settlement succeeds
        client.settle_payment(
            &payer,
            &recipient,
            &token_id.address(),
            &500_000,
            &nonce,
        );

        // Second settlement with identical canonical parameters must panic with AlreadySettled
        client.settle_payment(
            &payer,
            &recipient,
            &token_id.address(),
            &500_000,
            &nonce,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_zero_or_negative_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let payer = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token = Address::generate(&env);
        let nonce = BytesN::from_array(&env, &[1u8; 32]);

        client.settle_payment(&payer, &recipient, &token, &0, &nonce);
    }

    #[test]
    #[should_panic]
    fn test_unauthorized_payer_call_fails() {
        let env = Env::default();
        // Do NOT mock all auths: payer authorization MUST be checked

        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let payer = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token = Address::generate(&env);
        let nonce = BytesN::from_array(&env, &[7u8; 32]);

        // Must fail because payer did not authorize transaction
        client.settle_payment(&payer, &recipient, &token, &100_000, &nonce);
    }

    #[test]
    #[should_panic]
    fn test_insufficient_payer_balance_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin);
        let token_client = StellarAssetClient::new(&env, &token_id.address());
        token_client.mint(&payer, &100); // Only 100 stroops

        let nonce = BytesN::from_array(&env, &[15u8; 32]);

        // Attempts to transfer 500,000 stroops -> must panic with InsufficientBalance
        client.settle_payment(
            &payer,
            &recipient,
            &token_id.address(),
            &500_000,
            &nonce,
        );
    }

    #[test]
    fn test_receipt_not_found_on_unsettled_hash() {
        let env = Env::default();
        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let random_hash = BytesN::from_array(&env, &[88u8; 32]);
        assert_eq!(client.is_settled(&random_hash), false);
        assert_eq!(
            client.try_get_receipt(&random_hash),
            Err(Ok(X402Error::ReceiptNotFound))
        );
    }

    #[test]
    fn test_distinct_challenges_settle_independently() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let recipient_a = Address::generate(&env);
        let recipient_b = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin);
        let token_client = StellarAssetClient::new(&env, &token_id.address());
        token_client.mint(&payer, &10_000_000);

        let nonce_a = BytesN::from_array(&env, &[101u8; 32]);
        let nonce_b = BytesN::from_array(&env, &[102u8; 32]);

        let receipt_a = client.settle_payment(&payer, &recipient_a, &token_id.address(), &200_000, &nonce_a);
        let receipt_b = client.settle_payment(&payer, &recipient_b, &token_id.address(), &300_000, &nonce_b);

        assert_eq!(client.total_settlements(), 2);
        assert!(client.is_settled(&receipt_a.challenge_hash));
        assert!(client.is_settled(&receipt_b.challenge_hash));

        let r_a = client.get_receipt(&receipt_a.challenge_hash);
        let r_b = client.get_receipt(&receipt_b.challenge_hash);

        assert_eq!(r_a.amount, 200_000);
        assert_eq!(r_a.recipient, recipient_a);
        assert_eq!(r_b.amount, 300_000);
        assert_eq!(r_b.recipient, recipient_b);
    }

    #[test]
    fn test_adversarial_griefing_attempt_fails_to_burn_challenge() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(X402PaymentVault, ());
        let client = X402PaymentVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let alice_payer = Address::generate(&env);
        let bob_merchant = Address::generate(&env);
        let eve_attacker = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin);
        let token_client = StellarAssetClient::new(&env, &token_id.address());
        token_client.mint(&alice_payer, &10_000_000);
        token_client.mint(&eve_attacker, &10_000_000);

        // Bob issues challenge to Alice with a public nonce
        let public_nonce = BytesN::from_array(&env, &[250u8; 32]);
        let alice_expected_amount = 500_000i128; // 0.05 XLM

        let alice_challenge_hash = client.compute_challenge_hash(
            &bob_merchant,
            &token_id.address(),
            &alice_expected_amount,
            &public_nonce,
        );

        // Attacker Eve attempts to grief the challenge by calling vault with 1 stroop to Eve herself
        let eve_receipt = client.settle_payment(
            &eve_attacker,
            &eve_attacker, // Attacker's own address
            &token_id.address(),
            &1i128,        // Only 1 stroop!
            &public_nonce,
        );

        // Eve's hash is completely different from Alice's hash
        assert_ne!(eve_receipt.challenge_hash, alice_challenge_hash);
        assert!(client.is_settled(&eve_receipt.challenge_hash));
        assert_eq!(client.is_settled(&alice_challenge_hash), false);

        // Alice settles her legitimate challenge to Bob: MUST SUCCEED (Zero griefing!)
        let alice_receipt = client.settle_payment(
            &alice_payer,
            &bob_merchant,
            &token_id.address(),
            &alice_expected_amount,
            &public_nonce,
        );

        assert_eq!(alice_receipt.challenge_hash, alice_challenge_hash);
        assert_eq!(alice_receipt.amount, alice_expected_amount);
        assert_eq!(alice_receipt.recipient, bob_merchant);
        assert!(client.is_settled(&alice_challenge_hash));
        assert_eq!(client.total_settlements(), 2);

        // Bob the merchant received the full amount
        let token_query = token::Client::new(&env, &token_id.address());
        assert_eq!(token_query.balance(&bob_merchant), alice_expected_amount);
    }
}
