-- 001_initial.sql: PostgreSQL 16 Idempotent Migration for Distributed x402 Gateway
-- Preserves 100% of fields from ChallengeStore plus distributed lease & versioning attributes

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL,
  amount_stroops NUMERIC(40, 0) NOT NULL CHECK (amount_stroops > 0),
  asset TEXT NOT NULL,
  resource TEXT NOT NULL,
  memo TEXT,
  network TEXT NOT NULL,
  contract_id TEXT,
  token_address TEXT,
  beneficiary TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RECONCILIATION_REQUIRED', 'INCONCLUSIVE_MANUAL_REVIEW', 'CONFIRMED', 'REDEEMED', 'CANCELLED', 'PERMANENT_QUARANTINE')),
  created_at TIMESTAMPTZ NOT NULL,
  created_ledger BIGINT CHECK (created_ledger IS NULL OR created_ledger >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  bound_tx_hash TEXT UNIQUE,
  redeemed_at TIMESTAMPTZ,
  payer TEXT,
  paid_amount_stroops NUMERIC(40, 0) CHECK (paid_amount_stroops IS NULL OR paid_amount_stroops >= amount_stroops),
  redeemed_ledger BIGINT CHECK (redeemed_ledger IS NULL OR redeemed_ledger >= 0),
  min_valid_ledger BIGINT CHECK (min_valid_ledger IS NULL OR min_valid_ledger >= 0),
  max_valid_ledger BIGINT CHECK (max_valid_ledger IS NULL OR (max_valid_ledger >= 0 AND (min_valid_ledger IS NULL OR max_valid_ledger >= min_valid_ledger))),
  envelope_xdr TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT chk_challenge_expiry CHECK (expires_at >= created_at),
  CONSTRAINT chk_redeemed_consistency CHECK (
    (status != 'REDEEMED') OR (bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND redeemed_at IS NOT NULL)
  )
);

-- Evolutionary schema migration support for existing deployments
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS created_ledger BIGINT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS min_valid_ledger BIGINT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS max_valid_ledger BIGINT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS envelope_xdr TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS lease_generation BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS version BIGINT DEFAULT 1;

ALTER TABLE IF EXISTS challenges ALTER COLUMN lease_generation SET DEFAULT 0;
ALTER TABLE IF EXISTS challenges ALTER COLUMN version SET DEFAULT 1;
UPDATE challenges SET lease_generation = 0 WHERE lease_generation IS NULL;
UPDATE challenges SET version = 1 WHERE version IS NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN lease_generation SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN version SET NOT NULL;

-- Type conversions and check constraint enforcement for existing installations
ALTER TABLE IF EXISTS challenges ALTER COLUMN amount_stroops TYPE NUMERIC(40, 0);
ALTER TABLE IF EXISTS challenges ALTER COLUMN paid_amount_stroops TYPE NUMERIC(40, 0);

-- Evolutionary check constraints enforcement for existing installations
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_amount') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_amount CHECK (amount_stroops > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_status') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_status CHECK (status IN ('PENDING', 'RECONCILIATION_REQUIRED', 'INCONCLUSIVE_MANUAL_REVIEW', 'CONFIRMED', 'REDEEMED', 'CANCELLED', 'PERMANENT_QUARANTINE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_redeemed_consistency') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_redeemed_consistency CHECK ((status != 'REDEEMED') OR (bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND redeemed_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_ledgers') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_ledgers CHECK (
      (created_ledger IS NULL OR created_ledger >= 0) AND
      (min_valid_ledger IS NULL OR min_valid_ledger >= 0) AND
      (max_valid_ledger IS NULL OR (max_valid_ledger >= 0 AND (min_valid_ledger IS NULL OR max_valid_ledger >= min_valid_ledger)))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_i128_max') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_i128_max CHECK (amount_stroops <= 170141183460469231731687303715884105727 AND (paid_amount_stroops IS NULL OR paid_amount_stroops <= 170141183460469231731687303715884105727));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_expiry') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_expiry CHECK (expires_at >= created_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_paid_amount') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_paid_amount CHECK (paid_amount_stroops IS NULL OR paid_amount_stroops >= amount_stroops);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_redeemed_ledger') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_redeemed_ledger CHECK (redeemed_ledger IS NULL OR redeemed_ledger >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_lease_gen') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_lease_gen CHECK (lease_generation >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_version') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_version CHECK (version >= 1);
  END IF;
END $do$;

CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expires_at ON challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_challenges_bound_tx_hash ON challenges(bound_tx_hash);

CREATE TABLE IF NOT EXISTS redeemed_transactions (
  tx_hash TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
