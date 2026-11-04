-- 001_initial.sql: PostgreSQL 16 Idempotent & Fully Transactional Migration
-- Encompasses 100% of DDL operations in a single atomic transaction block

BEGIN;

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL,
  amount_stroops NUMERIC(40, 0),
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
  paid_amount_stroops NUMERIC(40, 0),
  redeemed_ledger BIGINT CHECK (redeemed_ledger IS NULL OR redeemed_ledger >= 0),
  min_valid_ledger BIGINT CHECK (min_valid_ledger IS NULL OR min_valid_ledger >= 0),
  max_valid_ledger BIGINT CHECK (max_valid_ledger IS NULL OR (max_valid_ledger >= 0 AND (min_valid_ledger IS NULL OR max_valid_ledger >= min_valid_ledger))),
  envelope_xdr TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT chk_challenge_expiry CHECK (expires_at >= created_at),
  CONSTRAINT chk_challenge_amount CHECK (
    (amount_stroops IS NOT NULL AND amount_stroops != 'NaN'::numeric AND amount_stroops > 0) OR
    (amount_stroops IS NULL AND status IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE'))
  ),
  CONSTRAINT chk_challenge_paid_amount CHECK (
    paid_amount_stroops IS NULL OR 
    (paid_amount_stroops != 'NaN'::numeric AND paid_amount_stroops > 0 AND (amount_stroops IS NULL OR paid_amount_stroops >= amount_stroops))
  ),
  CONSTRAINT chk_challenge_z_i128_max CHECK (
    (amount_stroops IS NULL OR amount_stroops <= 170141183460469231731687303715884105727) AND 
    (paid_amount_stroops IS NULL OR paid_amount_stroops <= 170141183460469231731687303715884105727)
  ),
  CONSTRAINT chk_redeemed_consistency CHECK (
    (status != 'REDEEMED') OR (bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND redeemed_at IS NOT NULL)
  ),
  CONSTRAINT uq_challenges_bound_tx_hash UNIQUE (bound_tx_hash)
);

-- Evolutionary schema migration support for existing deployments
-- 0. Early Drop of Legacy CHECK constraints and Incompatible UNIQUE constraints/indexes:
-- In legacy tables:
-- a) CHECK (status IN ('PENDING', 'REDEEMED')) would fail updates to 'RECONCILIATION_REQUIRED' or 'INCONCLUSIVE_MANUAL_REVIEW'.
-- b) Unique constraints/indexes with indnullsnotdistinct = true covering bound_tx_hash (e.g. (status, bound_tx_hash))
--    would fail if multiple rows with bound_tx_hash IS NULL converge to the same status (e.g. 'RECONCILIATION_REQUIRED') during EVOLVE_DATA!
-- Therefore, all legacy status checks and incompatible bound_tx_hash unique indexes/constraints MUST be dropped/renamed BEFORE EVOLVE_DATA.
DO $EARLY_STRUCTURAL_PURGE$
DECLARE
  r RECORD;
  status_attnum int2;
  bound_attnum int2;
  rename_suffix int := 1;
  target_rename text;
BEGIN
  SELECT attnum INTO status_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'status';
  SELECT attnum INTO bound_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'bound_tx_hash';

  -- A. Early drop of status check constraints
  IF status_attnum IS NOT NULL THEN
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_status;
    FOR r IN (
      SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = 'challenges'::regclass
        AND con.contype = 'c'
        AND (status_attnum = ANY(con.conkey) OR con.conkey = ARRAY[status_attnum])
    ) LOOP
      EXECUTE format('ALTER TABLE challenges DROP CONSTRAINT IF EXISTS %I', r.conname);
    END LOOP;
  END IF;

  -- B. Early handling of UNIQUE constraints and indexes covering bound_tx_hash
  IF bound_attnum IS NOT NULL THEN
    -- Case A: Name collision where 'uq_challenges_bound_tx_hash' exists covering other columns or with NULLS NOT DISTINCT
    -- If 'uq_challenges_bound_tx_hash' exists but does not match canonical definition (single-column bound_tx_hash with standard uniqueness), drop it early!
    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_index i ON i.indexrelid = con.conindid
      WHERE con.conrelid = 'challenges'::regclass
        AND con.contype = 'u'
        AND con.conname = 'uq_challenges_bound_tx_hash'
        AND (con.conkey != ARRAY[bound_attnum] OR i.indnullsnotdistinct = true)
    ) THEN
      ALTER TABLE challenges DROP CONSTRAINT uq_challenges_bound_tx_hash;
    END IF;

    -- Case B: Drop ANY non-canonical UNIQUE constraint covering bound_tx_hash in ANY position
    -- if it enforces NULLS NOT DISTINCT (which would reject multiple pending/reconciliation rows with hash NULL),
    -- or if it is a duplicate single-column unique constraint covering bound_tx_hash.
    FOR r IN (
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_index i ON i.indexrelid = con.conindid
      WHERE con.conrelid = 'challenges'::regclass
        AND con.contype = 'u'
        AND (bound_attnum = ANY(con.conkey))
        AND (
          con.conname != 'uq_challenges_bound_tx_hash'
          OR i.indnullsnotdistinct = true
          OR con.conkey != ARRAY[bound_attnum]
        )
    ) LOOP
      EXECUTE format('ALTER TABLE challenges DROP CONSTRAINT IF EXISTS %I', r.conname);
    END LOOP;

    -- Case C: If any lingering uq_challenges_bound_tx_hash has NULLS NOT DISTINCT = true, drop it
    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_index i ON i.indexrelid = con.conindid
      WHERE con.conrelid = 'challenges'::regclass
        AND con.contype = 'u'
        AND con.conname = 'uq_challenges_bound_tx_hash'
        AND i.indnullsnotdistinct = true
    ) THEN
      ALTER TABLE challenges DROP CONSTRAINT uq_challenges_bound_tx_hash;
    END IF;

    -- Case D: Early purge of standalone duplicate or incompatible indexes covering bound_tx_hash
    -- A. Closed Whitelist Policy: Drop ANY standalone unique index covering bound_tx_hash in ANY position
    --    with indnullsnotdistinct = true UNLESS its predicate matches a strictly closed and recognized
    --    top-level positive conjunction format where bound_tx_hash IS NOT NULL:
    --    - Predicate must NOT be NULL.
    --    - Must strictly match either the exact standalone predicate `(bound_tx_hash IS NOT NULL)`
    --      or a canonical top-level positive conjunction `((bound_tx_hash IS NOT NULL) AND ...)`.
    --    - Any predicate with OR, boolean wrappers (IS TRUE/FALSE), equality comparison on booleans,
    --      functions, or unrecognized syntax is conservatively treated as unsafe and purged!
    -- B. Drop redundant identical single-column btree text_ops index matching canonical definition,
    --    while strictly preserving valid partial indexes and specialized opclasses.
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
        AND con.oid IS NULL
        AND (bound_attnum = ANY(i.indkey[0:i.indnkeyatts-1]))
        AND (
          (
            i.indisunique = true 
            AND i.indnullsnotdistinct = true
            AND (
              i.indpred IS NULL
              OR (
                -- Closed Whitelist: ONLY exact standalone or top-level positive AND conjunctions without OR or boolean equality
                pg_get_expr(i.indpred, i.indrelid) !~* '^\(?\s*\(?\s*bound_tx_hash\s+IS\s+NOT\s+NULL\s*\)?(\s+AND\s+[^=><]+(?:<>[^=><]+|!=[^=><]+|=?\s*'[^']*')?)?\s*\)?$'
                OR pg_get_expr(i.indpred, i.indrelid) ~* '\s+OR\s+'
                OR pg_get_expr(i.indpred, i.indrelid) ~* '\)\s*=\s*\('
                OR pg_get_expr(i.indpred, i.indrelid) ~* 'IS\s+(NOT\s+)?(TRUE|FALSE)'
              )
            )
          )
          OR
          (
            i.indkey[0] = bound_attnum AND i.indnkeyatts = 1 AND i.indnatts = 1 AND i.indpred IS NULL
            AND am.amname = 'btree' AND opc.opcname = 'text_ops' AND opcnsp.nspname = 'pg_catalog'
            AND i.indoption[0] = 0
            AND i.indnullsnotdistinct = false
          )
        )
    ) LOOP
      EXECUTE format('DROP INDEX IF EXISTS %I', r.index_name);
    END LOOP;
  END IF;
END;
$EARLY_STRUCTURAL_PURGE$;

-- 1. Identifier alignment: rename legacy 'challenge_id' to canonical 'id' if table used legacy PK name
DO $EVOLVE_ID$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'challenge_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'id'
  ) THEN
    ALTER TABLE challenges RENAME COLUMN challenge_id TO id;
  END IF;
END;
$EVOLVE_ID$;

-- 2. Add any missing columns before enforcing constraints
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS resource TEXT DEFAULT 'mcp://tools/unknown';
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS amount_stroops NUMERIC(40, 0);
-- Drop legacy NOT NULL on amount_stroops so quarantined rows can hold NULL
ALTER TABLE IF EXISTS challenges ALTER COLUMN amount_stroops DROP NOT NULL;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS contract_id TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS token_address TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS beneficiary TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING';
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS bound_tx_hash TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS paid_amount_stroops NUMERIC(40, 0);
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS payer TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS redeemed_ledger BIGINT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS created_ledger BIGINT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS min_valid_ledger BIGINT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS max_valid_ledger BIGINT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS envelope_xdr TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS lease_generation BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS challenges ADD COLUMN IF NOT EXISTS version BIGINT DEFAULT 1;

-- 3. Populate amount_stroops and reconcile legacy statuses
DO $EVOLVE_DATA$
BEGIN
  -- Populate amount_stroops with exact scale and safe short-circuit evaluation:
  -- Validates string structure, integer magnitude (<= 30 digits before decimal), and positive value
  -- before any cast to NUMERIC to guarantee that corrupt or out-of-range strings never cause transaction aborts.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'amount'
  ) THEN
    UPDATE challenges 
    SET amount_stroops = (
      CASE 
        WHEN amount::TEXT ~ '^[0-9]{1,30}(\.[0-9]{1,7})?$' AND amount::TEXT != '0' AND amount::TEXT !~ '^0+(\.0+)?$'
        THEN (amount::NUMERIC * 10000000)::NUMERIC(40, 0)
        ELSE NULL
      END
    )
    WHERE (amount_stroops IS NULL OR amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric) 
      AND amount IS NOT NULL 
      AND (
        CASE 
          WHEN amount::TEXT ~ '^[0-9]{1,30}(\.[0-9]{1,7})?$' AND amount::TEXT != '0' AND amount::TEXT !~ '^0+(\.0+)?$'
          THEN true
          ELSE false
        END
      );
  END IF;

  -- Sanitize paid_amount_stroops across all rows:
  -- If paid_amount_stroops is NaN, non-positive, or corrupt, normalize it to NULL.
  UPDATE challenges
  SET paid_amount_stroops = NULL
  WHERE paid_amount_stroops IS NOT NULL 
    AND (paid_amount_stroops = 'NaN'::numeric OR paid_amount_stroops <= 0);

  -- Normalize unmetered, non-positive, or NaN legacy amounts:
  -- In canonical schema, amount_stroops must be NULL for quarantined rows (INCONCLUSIVE_MANUAL_REVIEW or PERMANENT_QUARANTINE),
  -- and strictly > 0 and != 'NaN' for operational rows.
  -- 1. Rows already in ANY quarantine state (INCONCLUSIVE_MANUAL_REVIEW or PERMANENT_QUARANTINE):
  -- Strictly normalize non-positive or NaN amount_stroops to NULL, preserving their respective quarantine status!
  UPDATE challenges
  SET amount_stroops = NULL
  WHERE status IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE')
    AND amount_stroops IS NOT NULL 
    AND (amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric);

  -- 2. Operational rows with amount_stroops <= 0, NaN, or unconvertible:
  -- Safely isolate into INCONCLUSIVE_MANUAL_REVIEW with amount_stroops = NULL
  UPDATE challenges
  SET status = 'INCONCLUSIVE_MANUAL_REVIEW', amount_stroops = NULL
  WHERE (amount_stroops IS NOT NULL AND (amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric));

  -- 3. Rows with amount_stroops IS NULL: isolate to INCONCLUSIVE_MANUAL_REVIEW if not already permanently quarantined
  UPDATE challenges 
  SET status = 'INCONCLUSIVE_MANUAL_REVIEW'
  WHERE amount_stroops IS NULL AND (status IS NULL OR status NOT IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE'));

  -- Sync legacy is_redeemed boolean/int to status:
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'is_redeemed'
  ) THEN
    UPDATE challenges 
    SET status = 'REDEEMED' 
    WHERE (status IS NULL OR status = 'PENDING') 
      AND (is_redeemed::TEXT = '1' OR is_redeemed::TEXT = 'true')
      AND bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND paid_amount_stroops != 'NaN'::numeric AND redeemed_at IS NOT NULL;

    UPDATE challenges 
    SET status = 'RECONCILIATION_REQUIRED' 
    WHERE (status IS NULL OR status = 'PENDING') 
      AND (is_redeemed::TEXT = '1' OR is_redeemed::TEXT = 'true')
      AND (bound_tx_hash IS NULL OR paid_amount_stroops IS NULL OR paid_amount_stroops = 'NaN'::numeric OR redeemed_at IS NULL);
  END IF;

  -- Reconcile any existing rows that were ALREADY marked 'REDEEMED' but lack proof or had NaN paid_amount:
  UPDATE challenges
  SET status = 'RECONCILIATION_REQUIRED'
  WHERE status = 'REDEEMED'
    AND (bound_tx_hash IS NULL OR paid_amount_stroops IS NULL OR paid_amount_stroops = 'NaN'::numeric OR redeemed_at IS NULL);
END;
$EVOLVE_DATA$;

-- 4. Temporal conversions: convert legacy BIGINT millisecond/second timestamps to TIMESTAMPTZ
DO $EVOLVE_TIMESTAMPS$
BEGIN
  -- created_at conversion
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'created_at' AND data_type LIKE '%int%'
  ) THEN
    ALTER TABLE challenges ALTER COLUMN created_at TYPE TIMESTAMPTZ USING 
      CASE 
        WHEN created_at > 1000000000000 THEN to_timestamp(created_at::DOUBLE PRECISION / 1000.0)
        ELSE to_timestamp(created_at::DOUBLE PRECISION)
      END;
  END IF;

  -- expires_at conversion
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'expires_at' AND data_type LIKE '%int%'
  ) THEN
    ALTER TABLE challenges ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING 
      CASE 
        WHEN expires_at > 1000000000000 THEN to_timestamp(expires_at::DOUBLE PRECISION / 1000.0)
        ELSE to_timestamp(expires_at::DOUBLE PRECISION)
      END;
  END IF;

  -- redeemed_at conversion
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'redeemed_at' AND data_type LIKE '%int%'
  ) THEN
    ALTER TABLE challenges ALTER COLUMN redeemed_at TYPE TIMESTAMPTZ USING 
      CASE 
        WHEN redeemed_at > 1000000000000 THEN to_timestamp(redeemed_at::DOUBLE PRECISION / 1000.0)
        ELSE to_timestamp(redeemed_at::DOUBLE PRECISION)
      END;
  END IF;
END;
$EVOLVE_TIMESTAMPS$;

-- 5. Set defaults and nullability on canonical columns
UPDATE challenges SET resource = 'mcp://tools/default' WHERE resource IS NULL;
-- Reconcile or quarantine unmetered rows without fabricating currency
UPDATE challenges SET status = 'INCONCLUSIVE_MANUAL_REVIEW' 
WHERE amount_stroops IS NULL AND (status IS NULL OR status NOT IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE'));
UPDATE challenges SET status = 'PENDING' WHERE status IS NULL;
UPDATE challenges SET lease_generation = 0 WHERE lease_generation IS NULL;
UPDATE challenges SET version = 1 WHERE version IS NULL;

ALTER TABLE IF EXISTS challenges ALTER COLUMN destination SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN status SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN asset SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN resource SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN network SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN lease_generation SET DEFAULT 0;
ALTER TABLE IF EXISTS challenges ALTER COLUMN version SET DEFAULT 1;
ALTER TABLE IF EXISTS challenges ALTER COLUMN lease_generation SET NOT NULL;
ALTER TABLE IF EXISTS challenges ALTER COLUMN version SET NOT NULL;

-- Type conversions
ALTER TABLE IF EXISTS challenges ALTER COLUMN amount_stroops TYPE NUMERIC(40, 0);
ALTER TABLE IF EXISTS challenges ALTER COLUMN paid_amount_stroops TYPE NUMERIC(40, 0);

-- Evolutionary check constraints enforcement and structural validation
DO $FINAL_INVARIANTS$
DECLARE
  bound_attnum int2;
BEGIN
  SELECT attnum INTO bound_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'bound_tx_hash';

  -- Canonical status CHECK constraint
  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_status;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_status CHECK (status IN ('PENDING', 'RECONCILIATION_REQUIRED', 'INCONCLUSIVE_MANUAL_REVIEW', 'CONFIRMED', 'REDEEMED', 'CANCELLED', 'PERMANENT_QUARANTINE'));

  -- Ensure canonical uq_challenges_bound_tx_hash exists covering exactly bound_tx_hash with standard uniqueness
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

  -- Invariant checks structural definition validation: Re-assert canonical definitions and ensure convalidated = true
  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_amount;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_amount CHECK (
    (amount_stroops IS NOT NULL AND amount_stroops != 'NaN'::numeric AND amount_stroops > 0) OR
    (amount_stroops IS NULL AND status IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE'))
  );

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_redeemed_consistency;
  ALTER TABLE challenges ADD CONSTRAINT chk_redeemed_consistency CHECK ((status != 'REDEEMED') OR (bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND redeemed_at IS NOT NULL));

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_ledgers;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_ledgers CHECK (
    (created_ledger IS NULL OR created_ledger >= 0) AND
    (min_valid_ledger IS NULL OR min_valid_ledger >= 0) AND
    (max_valid_ledger IS NULL OR (max_valid_ledger >= 0 AND (min_valid_ledger IS NULL OR max_valid_ledger >= min_valid_ledger)))
  );

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_paid_amount;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_paid_amount CHECK (
    paid_amount_stroops IS NULL OR 
    (paid_amount_stroops != 'NaN'::numeric AND paid_amount_stroops > 0 AND (amount_stroops IS NULL OR paid_amount_stroops >= amount_stroops))
  );

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_i128_max;
  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_z_i128_max;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_z_i128_max CHECK (
    (amount_stroops IS NULL OR amount_stroops <= 170141183460469231731687303715884105727) AND 
    (paid_amount_stroops IS NULL OR paid_amount_stroops <= 170141183460469231731687303715884105727)
  );

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_expiry;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_expiry CHECK (expires_at >= created_at);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_redeemed_ledger;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_redeemed_ledger CHECK (redeemed_ledger IS NULL OR redeemed_ledger >= 0);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_lease_gen;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_lease_gen CHECK (lease_generation >= 0);

  ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_version;
  ALTER TABLE challenges ADD CONSTRAINT chk_challenge_version CHECK (version >= 1);
END;
$FINAL_INVARIANTS$;

CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expires_at ON challenges(expires_at);

CREATE TABLE IF NOT EXISTS redeemed_transactions (
  tx_hash TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
