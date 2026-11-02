#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    token, Address, BytesN, Env, Symbol,
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
    /// Settle an x402 payment challenge on-chain.
    /// Transfers `amount` of `token` from `payer` to `recipient`,
    /// verifies anti-replay of `challenge_hash`, stores the receipt,
    /// and emits a `settle` event.
    pub fn settle_payment(
        env: Env,
        payer: Address,
        recipient: Address,
        token: Address,
        amount: i128,
        challenge_hash: BytesN<32>,
    ) -> Result<PaymentReceipt, X402Error> {
        // Payer must authorize this transfer
        payer.require_auth();

        if amount <= 0 {
            return Err(X402Error::InvalidAmount);
        }

        // Anti-replay: Ensure this challenge hash hasn't already been fulfilled
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

        let challenge_hash = BytesN::from_array(&env, &[42u8; 32]);
        let amount = 1_000_000i128; // 0.1 XLM in stroops

        let receipt = client.settle_payment(
            &payer,
            &recipient,
            &token_id.address(),
            &amount,
            &challenge_hash,
        );

        assert_eq!(receipt.amount, amount);
        assert_eq!(receipt.payer, payer);
        assert_eq!(receipt.recipient, recipient);
        assert_eq!(receipt.challenge_hash, challenge_hash);

        // Verification checks
        assert!(client.is_settled(&challenge_hash));
        let fetched = client.get_receipt(&challenge_hash);
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

        let challenge_hash = BytesN::from_array(&env, &[99u8; 32]);

        // First settlement succeeds
        client.settle_payment(
            &payer,
            &recipient,
            &token_id.address(),
            &500_000,
            &challenge_hash,
        );

        // Second settlement with same challenge_hash must fail
        client.settle_payment(
            &payer,
            &recipient,
            &token_id.address(),
            &500_000,
            &challenge_hash,
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
        let challenge_hash = BytesN::from_array(&env, &[1u8; 32]);

        client.settle_payment(&payer, &recipient, &token, &0, &challenge_hash);
    }
}
