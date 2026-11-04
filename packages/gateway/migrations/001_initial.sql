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
  bound_tx_hash TEXT,
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
  ),
  CONSTRAINT uq_challenges_bound_tx_hash UNIQUE (bound_tx_hash)
);

-- Evolutionary schema migration support for existing deployments
ALTER TABLE IF EXISTS challenges ALTER COLUMN destination SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN status SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN amount_stroops SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN asset SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN resource SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN network SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN expires_at SET NOT NULL;
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
DO $
DECLARE
  r RECORD;
  status_attnum int2;
  bound_attnum int2;
BEGIN
  -- Obtain exact attribute numbers for structural validation
  SELECT attnum INTO status_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'status';
  SELECT attnum INTO bound_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'bound_tx_hash';

  -- 1. Structural purge of single-column CHECK constraints on 'status' (array_length(conkey, 1) = 1)
  -- Preserves any composite / multi-column business constraints
  FOR r IN (
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'challenges'::regclass
      AND con.contype = 'c'
      AND con.conkey = ARRAY[status_attnum]
  ) LOOP
    EXECUTE format('ALTER TABLE challenges DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_status CHECK (status IN ('PENDING', 'RECONCILIATION_REQUIRED', 'INCONCLUSIVE_MANUAL_REVIEW', 'CONFIRMED', 'REDEEMED', 'CANCELLED', 'PERMANENT_QUARANTINE'));

  -- 2. Structural purge and canonical verification of UNIQUE constraint on 'bound_tx_hash'
  -- Drops any single-column UNIQUE constraints on bound_tx_hash whose definition or name is non-canonical,
  -- or if uq_challenges_bound_tx_hash does NOT strictly cover exactly ARRAY[bound_attnum]
  FOR r IN (
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'challenges'::regclass
      AND con.contype = 'u'
      AND (
        (con.conkey = ARRAY[bound_attnum] AND con.conname != 'uq_challenges_bound_tx_hash')
        OR (con.conname = 'uq_challenges_bound_tx_hash' AND con.conkey != ARRAY[bound_attnum])
      )
  ) LOOP
    EXECUTE format('ALTER TABLE challenges DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- Ensure canonical uq_challenges_bound_tx_hash exists covering exactly bound_tx_hash
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'challenges'::regclass
      AND contype = 'u'
      AND conname = 'uq_challenges_bound_tx_hash'
      AND conkey = ARRAY[bound_attnum]
  ) THEN
    ALTER TABLE challenges ADD CONSTRAINT uq_challenges_bound_tx_hash UNIQUE (bound_tx_hash);
  END IF;

  -- 3. Invariant checks structural enforcement
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_amount') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_amount CHECK (amount_stroops > 0);
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
END $;o$;

CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expires_at ON challenges(expires_at);
-- Note: bound_tx_hash already has an implicit unique b-tree index created by uq_challenges_bound_tx_hash / UNIQUE constraint.
-- Any redundant standalone index is dropped to optimize storage and write amplification:
DROP INDEX IF EXISTS idx_challenges_bound_tx_hash;

CREATE TABLE IF NOT EXISTS redeemed_transactions (
  tx_hash TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
