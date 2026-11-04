-- 001_initial.sql: PostgreSQL 16 Idempotent Migration for Distributed x402 Gateway
-- Preserves 100% of fields from ChallengeStore plus distributed lease & versioning attributes

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL,
  amount_stroops NUMERIC(38, 0) NOT NULL,
  asset TEXT NOT NULL,
  resource TEXT NOT NULL,
  memo TEXT,
  network TEXT NOT NULL,
  contract_id TEXT,
  token_address TEXT,
  beneficiary TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL,
  created_ledger BIGINT,
  expires_at TIMESTAMPTZ NOT NULL,
  bound_tx_hash TEXT UNIQUE,
  redeemed_at TIMESTAMPTZ,
  payer TEXT,
  paid_amount_stroops NUMERIC(38, 0),
  redeemed_ledger BIGINT,
  min_valid_ledger BIGINT,
  max_valid_ledger BIGINT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_generation BIGINT DEFAULT 0,
  version BIGINT DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expires_at ON challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_challenges_bound_tx_hash ON challenges(bound_tx_hash);

CREATE TABLE IF NOT EXISTS redeemed_transactions (
  tx_hash TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
