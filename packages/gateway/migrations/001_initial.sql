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

  -- 1. Structural purge of legacy CHECK constraints covering 'status'
  -- Unconditionally drops any constraint named 'chk_challenge_status' (even if CHECK (TRUE)) plus any legacy single-column check on status_attnum
  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_status;
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
  -- RENAME the existing constraint dynamically checking pg_constraint AND pg_class in current schema to prevent index collisions
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'challenges'::regclass
      AND contype = 'u'
      AND conname = 'uq_challenges_bound_tx_hash'
      AND conkey != ARRAY[bound_attnum]
  ) THEN
    LOOP
      target_rename := 'uq_challenges_legacy_composite_' || rename_suffix::text;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'challenges'::regclass)
          AND c.conname = target_rename
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'challenges'::regclass)
          AND relname = target_rename
      ) THEN
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
      AND con.connullsnotdistinct = false -- Strictly preserves any non-standard NULLS NOT DISTINCT constraint
  ) LOOP
    EXECUTE format('ALTER TABLE challenges DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- Case C: Ensure canonical uq_challenges_bound_tx_hash exists covering exactly bound_tx_hash
  -- If another relation in the schema already occupies the canonical name, abort with explicit actionable diagnostic
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'challenges'::regclass
      AND contype = 'u'
      AND conname = 'uq_challenges_bound_tx_hash'
      AND conkey = ARRAY[bound_attnum]
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_class
      WHERE relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'challenges'::regclass)
        AND relname = 'uq_challenges_bound_tx_hash'
    ) THEN
      RAISE EXCEPTION 'Schema namespace collision: uq_challenges_bound_tx_hash is already occupied by a foreign relation or index in schema';
    END IF;
    ALTER TABLE challenges ADD CONSTRAINT uq_challenges_bound_tx_hash UNIQUE (bound_tx_hash);
  END IF;

  -- 3. Case D: Drop only standalone indexes whose structural definition matches the canonical constraint index identically
  FOR r IN (
    SELECT idx.relname AS index_name
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_am am ON am.oid = idx.relam
    JOIN pg_opclass opc ON opc.oid = i.indclass[0]
    JOIN pg_namespace opcnsp ON opcnsp.oid = opc.opcnamespace
    LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
    WHERE tbl.oid = 'challenges'::regclass
      AND i.indnkeyatts = 1
      AND i.indnatts = 1 -- Strictly exactly 1 column total: PRESERVES any INCLUDE columns!
      AND i.indkey[0] = bound_attnum
      AND i.indpred IS NULL -- Preserves partial indexes!
      AND am.amname = 'btree'
      AND opc.opcname = 'text_ops' AND opcnsp.nspname = 'pg_catalog' -- Canonical pg_catalog.text_ops: PRESERVES text_pattern_ops!
      -- Match collation identical to the canonical constraint index backing uq_challenges_bound_tx_hash
      AND i.indcollation[0] = (
        SELECT ci.indcollation[0] FROM pg_index ci
        JOIN pg_constraint cc ON cc.conindid = ci.indexrelid
        WHERE cc.conrelid = 'challenges'::regclass AND cc.conname = 'uq_challenges_bound_tx_hash'
      )
      AND i.indoption[0] = 0 -- Default ASC/NULLS LAST
      AND i.indnullsnotdistinct = false -- Strictly matches canonical standard unique nullability
      AND con.oid IS NULL -- Not backing a constraint
  ) LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', r.index_name);
  END LOOP;

  -- 4. Invariant checks structural definition validation: Re-assert canonical definitions and ensure convalidated = true
  -- Drop existing named check if definition or validity differs, then add canonical validated check
  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_amount;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_amount CHECK (amount_stroops > 0);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_redeemed_consistency;
  ALTER TABLE challenges ADD CONSTRAINT chk_redeemed_consistency CHECK ((status != 'REDEEMED') OR (bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND redeemed_at IS NOT NULL));

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_ledgers;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_ledgers CHECK (
    (created_ledger IS NULL OR created_ledger >= 0) AND
    (min_valid_ledger IS NULL OR min_valid_ledger >= 0) AND
    (max_valid_ledger IS NULL OR (max_valid_ledger >= 0 AND (min_valid_ledger IS NULL OR max_valid_ledger >= min_valid_ledger)))
  );

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_i128_max;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_i128_max CHECK (amount_stroops <= 170141183460469231731687303715884105727 AND (paid_amount_stroops IS NULL OR paid_amount_stroops <= 170141183460469231731687303715884105727));

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_expiry;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_expiry CHECK (expires_at >= created_at);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_paid_amount;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_paid_amount CHECK (paid_amount_stroops IS NULL OR paid_amount_stroops >= amount_stroops);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_redeemed_ledger;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_redeemed_ledger CHECK (redeemed_ledger IS NULL OR redeemed_ledger >= 0);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_lease_gen;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_lease_gen CHECK (lease_generation >= 0);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_version;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_version CHECK (version >= 1);
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
