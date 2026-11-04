-- 001_initial.sql: PostgreSQL 16 Idempotent & Fully Transactional Migration
-- Encompasses 100% of DDL operations in a single atomic transaction block

BEGIN;

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

-- Type conversions
ALTER TABLE IF EXISTS challenges ALTER COLUMN amount_stroops TYPE NUMERIC(40, 0);
ALTER TABLE IF EXISTS challenges ALTER COLUMN paid_amount_stroops TYPE NUMERIC(40, 0);

-- Evolutionary check constraints enforcement and structural validation
DO $BODY$
DECLARE
  r RECORD;
  status_attnum int2;
  bound_attnum int2;
  rename_suffix int := 1;
  target_rename text;
BEGIN
  -- Obtain exact attribute numbers for structural validation
  SELECT attnum INTO status_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'status';
  SELECT attnum INTO bound_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'bound_tx_hash';

  -- 1. Structural purge of legacy single-column CHECK constraints strictly covering ONLY 'status'
  -- Checks with array_length(conkey, 1) = 1 on status_attnum. Any composite/multi-column check is strictly preserved!
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

  -- 2. Structural handling of UNIQUE constraints covering bound_tx_hash
  -- Case A: Name collision where 'uq_challenges_bound_tx_hash' exists on different columns.
  -- RENAME the existing constraint dynamically with unique suffix to preserve business invariants rather than dropping it!
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'challenges'::regclass
      AND contype = 'u'
      AND conname = 'uq_challenges_bound_tx_hash'
      AND conkey != ARRAY[bound_attnum]
  ) THEN
    LOOP
      target_rename := 'uq_challenges_legacy_composite_' || rename_suffix::text;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = target_rename) THEN
        EXECUTE format('ALTER TABLE challenges RENAME CONSTRAINT uq_challenges_bound_tx_hash TO %I', target_rename);
        EXIT;
      END IF;
      rename_suffix := rename_suffix + 1;
    END LOOP;
  END IF;

  -- Case B: Drop non-canonical single-column UNIQUE constraints strictly covering bound_tx_hash
  FOR r IN (
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'challenges'::regclass
      AND con.contype = 'u'
      AND con.conkey = ARRAY[bound_attnum]
      AND con.conname != 'uq_challenges_bound_tx_hash'
  ) LOOP
    EXECUTE format('ALTER TABLE challenges DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- Case C: Ensure canonical uq_challenges_bound_tx_hash exists covering exactly bound_tx_hash
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'challenges'::regclass
      AND contype = 'u'
      AND conname = 'uq_challenges_bound_tx_hash'
      AND conkey = ARRAY[bound_attnum]
  ) THEN
    ALTER TABLE challenges ADD CONSTRAINT uq_challenges_bound_tx_hash UNIQUE (bound_tx_hash);
  END IF;

  -- 3. Case D: Drop any redundant standalone indexes strictly on bound_tx_hash (leaving constraint index)
  FOR r IN (
    SELECT idx.relname AS index_name
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
    WHERE tbl.oid = 'challenges'::regclass
      AND i.indnkeyatts = 1
      AND i.indkey[0] = bound_attnum
      AND con.oid IS NULL -- Not backing a constraint
  ) LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', r.index_name);
  END LOOP;

  -- 4. Invariant checks structural definition validation
  -- Amount > 0
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_amount') THEN
    IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_amount')) !~ '^\s*CHECK\s*\(\s*\(?amount_stroops\s*>\s*0\)?\s*\)\s*$' THEN
      ALTER TABLE challenges DROP CONSTRAINT chk_challenge_amount;
      ALTER TABLE challenges ADD CONSTRAINT chk_challenge_amount CHECK (amount_stroops > 0);
    END IF;
  ELSE
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_amount CHECK (amount_stroops > 0);
  END IF;

  -- Redeemed consistency
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_redeemed_consistency') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_redeemed_consistency CHECK ((status != 'REDEEMED') OR (bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND redeemed_at IS NOT NULL));
  END IF;

  -- Ledgers non-negative
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_ledgers') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_ledgers CHECK (
      (created_ledger IS NULL OR created_ledger >= 0) AND
      (min_valid_ledger IS NULL OR min_valid_ledger >= 0) AND
      (max_valid_ledger IS NULL OR (max_valid_ledger >= 0 AND (min_valid_ledger IS NULL OR max_valid_ledger >= min_valid_ledger)))
    );
  END IF;

  -- i128 max bound
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_i128_max') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_i128_max CHECK (amount_stroops <= 170141183460469231731687303715884105727 AND (paid_amount_stroops IS NULL OR paid_amount_stroops <= 170141183460469231731687303715884105727));
  END IF;

  -- Expiry after creation
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_expiry') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_expiry CHECK (expires_at >= created_at);
  END IF;

  -- Paid amount >= requested amount
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_paid_amount') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_paid_amount CHECK (paid_amount_stroops IS NULL OR paid_amount_stroops >= amount_stroops);
  END IF;

  -- Redeemed ledger non-negative
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_redeemed_ledger') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_redeemed_ledger CHECK (redeemed_ledger IS NULL OR redeemed_ledger >= 0);
  END IF;

  -- Lease generation >= 0
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_lease_gen') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_lease_gen CHECK (lease_generation >= 0);
  END IF;

  -- Version >= 1
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'challenges'::regclass AND conname = 'chk_challenge_version') THEN
    ALTER TABLE challenges ADD CONSTRAINT chk_challenge_version CHECK (version >= 1);
  END IF;
END;
$BODY$;

CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expires_at ON challenges(expires_at);

CREATE TABLE IF NOT EXISTS redeemed_transactions (
  tx_hash TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
