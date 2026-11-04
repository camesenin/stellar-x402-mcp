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
  amount_attnum int2;
  paid_amount_attnum int2;
  rename_suffix int := 1;
  target_rename text;
BEGIN
  SELECT attnum INTO status_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'status';
  SELECT attnum INTO bound_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'bound_tx_hash';
  SELECT attnum INTO amount_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'amount_stroops';
  SELECT attnum INTO paid_amount_attnum FROM pg_attribute WHERE attrelid = 'challenges'::regclass AND attname = 'paid_amount_stroops';

  -- A. Early drop of status and monetary check constraints:
  -- Drops legacy status checks and any legacy monetary check covering amount_stroops or paid_amount_stroops
  -- (e.g. legacy check `paid_amount_stroops >= amount_stroops`) so that evolutionary data conversions
  -- (e.g. converting amount='0.05' to amount_stroops=500000 while paid_amount_stroops=1)
  -- do NOT abort before EVOLVE_DATA can record evidence and sanitize underpaid rows!
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

  IF amount_attnum IS NOT NULL OR paid_amount_attnum IS NOT NULL THEN
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_amount;
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_paid_amount;
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_i128_max;
    ALTER TABLE challenges DROP CONSTRAINT IF EXISTS chk_challenge_z_i128_max;
    FOR r IN (
      SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = 'challenges'::regclass
        AND con.contype = 'c'
        AND (
          (amount_attnum IS NOT NULL AND amount_attnum = ANY(con.conkey))
          OR (paid_amount_attnum IS NOT NULL AND paid_amount_attnum = ANY(con.conkey))
        )
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
                pg_get_expr(i.indpred, i.indrelid) !~* $PRED$^\(?\s*\(?\s*bound_tx_hash\s+IS\s+NOT\s+NULL\s*\)?(\s+AND\s+[^=><]+(?:<>[^=><]+|!=[^=><]+|=?\s*'[^']*')?)?\s*\)?$$PRED$
                OR pg_get_expr(i.indpred, i.indrelid) ~* $PRED$\s+OR\s+$PRED$
                OR pg_get_expr(i.indpred, i.indrelid) ~* $PRED$\)\s*=\s*\($PRED$
                OR pg_get_expr(i.indpred, i.indrelid) ~* $PRED$IS\s+(NOT\s+)?(TRUE|FALSE)$PRED$
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

-- Evidence preservation audit table (created early to capture all pre-sanitization values)
CREATE TABLE IF NOT EXISTS migration_audit_log (
  id BIGSERIAL PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  migration_step TEXT NOT NULL,
  pre_status TEXT,
  pre_amount_stroops NUMERIC(40, 0),
  pre_paid_amount_stroops NUMERIC(40, 0),
  pre_amount_stroops_raw TEXT,
  pre_paid_amount_stroops_raw TEXT,
  pre_amount_text TEXT,
  pre_bound_tx_hash TEXT,
  sanitization_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- Explicit schema evolution for brownfield deployments where migration_audit_log already existed:
-- 1. First add raw text columns to capture verbatim strings before any type alteration
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_amount_stroops_raw TEXT;
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_paid_amount_stroops_raw TEXT;
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_amount_text TEXT;
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_bound_tx_hash TEXT;
-- 2. Backfill pre_amount_stroops_raw and pre_paid_amount_stroops_raw from existing numeric columns BEFORE modifying their types or scale
UPDATE migration_audit_log
SET pre_amount_stroops_raw = COALESCE(pre_amount_stroops_raw, pre_amount_stroops::TEXT),
    pre_paid_amount_stroops_raw = COALESCE(pre_paid_amount_stroops_raw, pre_paid_amount_stroops::TEXT)
WHERE pre_amount_stroops IS NOT NULL OR pre_paid_amount_stroops IS NOT NULL;
-- 3. Safely harmonize column types to NUMERIC(40,0) without losing evidence
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_amount_stroops NUMERIC(40, 0);
ALTER TABLE IF EXISTS migration_audit_log ALTER COLUMN pre_amount_stroops TYPE NUMERIC(40, 0);
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_paid_amount_stroops NUMERIC(40, 0);
ALTER TABLE IF EXISTS migration_audit_log ALTER COLUMN pre_paid_amount_stroops TYPE NUMERIC(40, 0);
CREATE INDEX IF NOT EXISTS idx_migration_audit_challenge ON migration_audit_log(challenge_id);

-- 3. Populate amount_stroops and reconcile legacy statuses
DO $EVOLVE_DATA$
BEGIN
  -- SNAPSHOT STEP: Capture initial pre-sanitization state before any column conversion or update
  -- Stores initial values in migration_audit_log with migration_step = 'INITIAL_PRE_MIGRATION_SNAPSHOT'
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'amount'
  ) THEN
    INSERT INTO migration_audit_log (
      challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason
    )
    SELECT 
      id, 'INITIAL_PRE_MIGRATION_SNAPSHOT', status,
      CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
      CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
      amount_stroops::TEXT, paid_amount_stroops::TEXT, amount::TEXT, bound_tx_hash, 'CAPTURE_INITIAL_OBSERVED_STATE'
    FROM challenges
    WHERE NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'INITIAL_PRE_MIGRATION_SNAPSHOT'
    );
  ELSE
    INSERT INTO migration_audit_log (
      challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason
    )
    SELECT 
      id, 'INITIAL_PRE_MIGRATION_SNAPSHOT', status,
      CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
      CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
      amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'CAPTURE_INITIAL_OBSERVED_STATE'
    FROM challenges
    WHERE NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'INITIAL_PRE_MIGRATION_SNAPSHOT'
    );
  END IF;

  -- A. Populate amount_stroops with exact scale and safe short-circuit evaluation:
  -- Validates string structure, integer magnitude (<= 30 digits before decimal), and positive value
  -- before any cast to NUMERIC to guarantee that corrupt or out-of-range strings never cause transaction aborts.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'amount'
  ) THEN
    UPDATE challenges 
    SET amount_stroops = (
      CASE 
        WHEN amount::TEXT ~ $REGEX$^[0-9]{1,30}(\.[0-9]{1,7})?$$REGEX$ AND amount::TEXT != '0' AND amount::TEXT !~ $REGEX$^0+(\.0+)?$$REGEX$
        THEN (amount::NUMERIC * 10000000)::NUMERIC(40, 0)
        ELSE NULL
      END
    )
    WHERE (amount_stroops IS NULL OR amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric) 
      AND amount IS NOT NULL 
      AND (
        CASE 
          WHEN amount::TEXT ~ $REGEX$^[0-9]{1,30}(\.[0-9]{1,7})?$$REGEX$ AND amount::TEXT != '0' AND amount::TEXT !~ $REGEX$^0+(\.0+)?$$REGEX$
          THEN true
          ELSE false
        END
      );
  END IF;

  -- B. Evidence Preservation & Sanitization of paid_amount_stroops across all rows:
  -- If paid_amount_stroops is NaN, non-positive, or corrupt, record specific evidence and normalize to NULL.
  -- STRICT INVARIANT: Status is NEVER changed here, preserving PERMANENT_QUARANTINE and INCONCLUSIVE_MANUAL_REVIEW!
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'SANITIZE_PAID_AMOUNT', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'INVALID_NON_POSITIVE_OR_NAN_PAID_AMOUNT'
  FROM challenges
  WHERE paid_amount_stroops IS NOT NULL AND (paid_amount_stroops = 'NaN'::numeric OR paid_amount_stroops <= 0)
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'SANITIZE_PAID_AMOUNT'
    );

  UPDATE challenges
  SET paid_amount_stroops = NULL
  WHERE paid_amount_stroops IS NOT NULL 
    AND (paid_amount_stroops = 'NaN'::numeric OR paid_amount_stroops <= 0);

  -- B2. Fractional Stroops Quarantine: detect non-integer fractional amounts in amount_stroops or paid_amount_stroops
  -- Stroops in Stellar are strictly discrete integer units. If an unconstrained brownfield column contains fractional stroops (e.g. 1.4),
  -- converting directly with ALTER COLUMN TYPE NUMERIC(40,0) would silently round monetary balances!
  -- Instead, detect non-integer values (value != trunc(value)), capture exact raw evidence, and quarantine to RECONCILIATION_REQUIRED.
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'FRACTIONAL_STROOPS_QUARANTINE', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'FRACTIONAL_STROOPS_DETECTED'
  FROM challenges
  WHERE (
    (amount_stroops IS NOT NULL AND amount_stroops != 'NaN'::numeric AND amount_stroops != trunc(amount_stroops))
    OR
    (paid_amount_stroops IS NOT NULL AND paid_amount_stroops != 'NaN'::numeric AND paid_amount_stroops != trunc(paid_amount_stroops))
  )
  AND NOT EXISTS (
    SELECT 1 FROM migration_audit_log mal 
    WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'FRACTIONAL_STROOPS_QUARANTINE'
  );

  UPDATE challenges
  SET amount_stroops = CASE 
        WHEN amount_stroops IS NOT NULL AND amount_stroops != 'NaN'::numeric AND amount_stroops != trunc(amount_stroops) THEN NULL 
        ELSE amount_stroops 
      END,
      paid_amount_stroops = CASE 
        WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops != 'NaN'::numeric AND paid_amount_stroops != trunc(paid_amount_stroops) THEN NULL 
        ELSE paid_amount_stroops 
      END,
      status = CASE 
        WHEN status IN ('PERMANENT_QUARANTINE', 'INCONCLUSIVE_MANUAL_REVIEW') THEN status 
        -- If requested amount itself was fractional, amount_stroops becomes NULL -> must isolate to INCONCLUSIVE_MANUAL_REVIEW to satisfy chk_challenge_amount!
        WHEN amount_stroops IS NOT NULL AND amount_stroops != 'NaN'::numeric AND amount_stroops != trunc(amount_stroops) THEN 'INCONCLUSIVE_MANUAL_REVIEW'
        -- If only paid_amount_stroops was fractional but requested amount was valid integer, isolate to RECONCILIATION_REQUIRED
        ELSE 'RECONCILIATION_REQUIRED' 
      END
  WHERE (
    (amount_stroops IS NOT NULL AND amount_stroops != 'NaN'::numeric AND amount_stroops != trunc(amount_stroops))
    OR
    (paid_amount_stroops IS NOT NULL AND paid_amount_stroops != 'NaN'::numeric AND paid_amount_stroops != trunc(paid_amount_stroops))
  );

  -- C. Handle legacy amounts exceeding i128::MAX (170141183460469231731687303715884105727):
  -- 1. If paid_amount_stroops > i128::MAX:
  -- Record evidence. Normalize paid_amount_stroops to NULL.
  -- STRICT INVARIANT: If status IN ('PERMANENT_QUARANTINE', 'INCONCLUSIVE_MANUAL_REVIEW'), PRESERVE status!
  -- Only operational rows transition to RECONCILIATION_REQUIRED.
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'OVERFLOW_PAID_AMOUNT_I128', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'PAID_AMOUNT_EXCEEDS_I128_MAX'
  FROM challenges
  WHERE paid_amount_stroops IS NOT NULL AND paid_amount_stroops != 'NaN'::numeric AND paid_amount_stroops > 170141183460469231731687303715884105727
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'OVERFLOW_PAID_AMOUNT_I128'
    );

  UPDATE challenges
  SET paid_amount_stroops = NULL,
      status = CASE 
        WHEN status IN ('PERMANENT_QUARANTINE', 'INCONCLUSIVE_MANUAL_REVIEW') THEN status 
        ELSE 'RECONCILIATION_REQUIRED' 
      END
  WHERE paid_amount_stroops IS NOT NULL 
    AND paid_amount_stroops != 'NaN'::numeric 
    AND paid_amount_stroops > 170141183460469231731687303715884105727;

  -- 2. If amount_stroops > i128::MAX:
  -- Record evidence. Normalize amount_stroops to NULL.
  -- STRICT INVARIANT: If status = 'PERMANENT_QUARANTINE', status is PRESERVED!
  -- Operational rows transition to INCONCLUSIVE_MANUAL_REVIEW.
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'OVERFLOW_AMOUNT_I128', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'REQUESTED_AMOUNT_EXCEEDS_I128_MAX'
  FROM challenges
  WHERE amount_stroops IS NOT NULL AND amount_stroops != 'NaN'::numeric AND amount_stroops > 170141183460469231731687303715884105727
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'OVERFLOW_AMOUNT_I128'
    );

  UPDATE challenges
  SET amount_stroops = NULL,
      status = CASE 
        WHEN status = 'PERMANENT_QUARANTINE' THEN 'PERMANENT_QUARANTINE'
        ELSE 'INCONCLUSIVE_MANUAL_REVIEW'
      END
  WHERE amount_stroops IS NOT NULL 
    AND amount_stroops != 'NaN'::numeric 
    AND amount_stroops > 170141183460469231731687303715884105727;

  -- D. Normalize unmetered, non-positive, or NaN legacy amounts:
  -- In canonical schema, amount_stroops must be NULL for quarantined rows (INCONCLUSIVE_MANUAL_REVIEW or PERMANENT_QUARANTINE),
  -- and strictly > 0 and != 'NaN' for operational rows.
  -- 1. Rows already in ANY quarantine state (INCONCLUSIVE_MANUAL_REVIEW or PERMANENT_QUARANTINE):
  -- Record evidence before normalizing non-positive or NaN amount_stroops to NULL, preserving their respective quarantine status!
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'QUARANTINE_AMOUNT_NORMALIZATION', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'QUARANTINE_AMOUNT_NORMALIZED_TO_NULL'
  FROM challenges
  WHERE status IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE')
    AND amount_stroops IS NOT NULL 
    AND (amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric)
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'QUARANTINE_AMOUNT_NORMALIZATION'
    );

  UPDATE challenges
  SET amount_stroops = NULL
  WHERE status IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE')
    AND amount_stroops IS NOT NULL 
    AND (amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric);

  -- 2. Operational rows with amount_stroops <= 0, NaN, or unconvertible:
  -- Record evidence. Safely isolate into INCONCLUSIVE_MANUAL_REVIEW with amount_stroops = NULL
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'OPERATIONAL_AMOUNT_INVALID', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'OPERATIONAL_NON_POSITIVE_AMOUNT_ISOLATED'
  FROM challenges
  WHERE (amount_stroops IS NOT NULL AND (amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric))
    AND status NOT IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE')
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'OPERATIONAL_AMOUNT_INVALID'
    );

  UPDATE challenges
  SET status = 'INCONCLUSIVE_MANUAL_REVIEW', amount_stroops = NULL
  WHERE (amount_stroops IS NOT NULL AND (amount_stroops <= 0 OR amount_stroops = 'NaN'::numeric));

  -- 3. Rows with amount_stroops IS NULL: isolate to INCONCLUSIVE_MANUAL_REVIEW if not already permanently quarantined
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'UNMETERED_AMOUNT_NULL', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'UNMETERED_ROW_ISOLATED_TO_INCONCLUSIVE'
  FROM challenges
  WHERE amount_stroops IS NULL AND (status IS NULL OR status NOT IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE'))
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'UNMETERED_AMOUNT_NULL'
    );

  UPDATE challenges 
  SET status = 'INCONCLUSIVE_MANUAL_REVIEW'
  WHERE amount_stroops IS NULL AND (status IS NULL OR status NOT IN ('INCONCLUSIVE_MANUAL_REVIEW', 'PERMANENT_QUARANTINE'));

  -- E. Handle legacy underpaid rows (paid_amount_stroops < amount_stroops):
  -- In canonical schema, chk_challenge_paid_amount requires paid_amount_stroops >= amount_stroops.
  -- Record evidence in migration_audit_log.
  -- STRICT INVARIANT: If row is in PERMANENT_QUARANTINE or INCONCLUSIVE_MANUAL_REVIEW, PRESERVE its status!
  -- Only operational rows transition to RECONCILIATION_REQUIRED.
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'UNDERPAID_CHALLENGE', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'PAID_AMOUNT_LESS_THAN_REQUESTED_AMOUNT'
  FROM challenges
  WHERE amount_stroops IS NOT NULL AND paid_amount_stroops IS NOT NULL AND paid_amount_stroops < amount_stroops
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'UNDERPAID_CHALLENGE'
    );

  UPDATE challenges
  SET paid_amount_stroops = NULL,
      status = CASE 
        WHEN status IN ('PERMANENT_QUARANTINE', 'INCONCLUSIVE_MANUAL_REVIEW') THEN status 
        ELSE 'RECONCILIATION_REQUIRED' 
      END
  WHERE amount_stroops IS NOT NULL 
    AND paid_amount_stroops IS NOT NULL 
    AND paid_amount_stroops < amount_stroops;

  -- F. Sync legacy is_redeemed boolean/int to status:
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'challenges' AND column_name = 'is_redeemed'
  ) THEN
    UPDATE challenges 
    SET status = 'REDEEMED' 
    WHERE (status IS NULL OR status = 'PENDING') 
      AND (is_redeemed::TEXT = '1' OR is_redeemed::TEXT = 'true')
      AND bound_tx_hash IS NOT NULL AND paid_amount_stroops IS NOT NULL AND paid_amount_stroops != 'NaN'::numeric 
      AND paid_amount_stroops >= amount_stroops AND redeemed_at IS NOT NULL;

    INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
    SELECT id, 'RECONCILE_INCOMPLETE_REDEEMED', status,
      CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
      CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
      amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'LEGACY_IS_REDEEMED_LACKS_PROOF'
    FROM challenges
    WHERE (status IS NULL OR status = 'PENDING') 
      AND (is_redeemed::TEXT = '1' OR is_redeemed::TEXT = 'true')
      AND (bound_tx_hash IS NULL OR paid_amount_stroops IS NULL OR paid_amount_stroops = 'NaN'::numeric OR paid_amount_stroops < amount_stroops OR redeemed_at IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM migration_audit_log mal 
        WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'RECONCILE_INCOMPLETE_REDEEMED'
      );

    UPDATE challenges 
    SET status = 'RECONCILIATION_REQUIRED', paid_amount_stroops = CASE WHEN paid_amount_stroops < amount_stroops THEN NULL ELSE paid_amount_stroops END
    WHERE (status IS NULL OR status = 'PENDING') 
      AND (is_redeemed::TEXT = '1' OR is_redeemed::TEXT = 'true')
      AND (bound_tx_hash IS NULL OR paid_amount_stroops IS NULL OR paid_amount_stroops = 'NaN'::numeric OR paid_amount_stroops < amount_stroops OR redeemed_at IS NULL);
  END IF;

  -- G. Reconcile any existing rows that were ALREADY marked 'REDEEMED' but lack proof, had NaN paid_amount, or were underpaid:
  INSERT INTO migration_audit_log (challenge_id, migration_step, pre_status, pre_amount_stroops, pre_paid_amount_stroops, pre_amount_stroops_raw, pre_paid_amount_stroops_raw, pre_amount_text, pre_bound_tx_hash, sanitization_reason)
  SELECT id, 'RECONCILE_UNPROVEN_REDEEMED', status,
    CASE WHEN amount_stroops IS NOT NULL AND amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    CASE WHEN paid_amount_stroops IS NOT NULL AND paid_amount_stroops::TEXT ~ '^-?[0-9]{1,40}$' THEN paid_amount_stroops::NUMERIC(40, 0) ELSE NULL END,
    amount_stroops::TEXT, paid_amount_stroops::TEXT, NULL, bound_tx_hash, 'REDEEMED_ROW_LACKS_PROOF_OR_PAYMENT'
  FROM challenges
  WHERE status = 'REDEEMED'
    AND (bound_tx_hash IS NULL OR paid_amount_stroops IS NULL OR paid_amount_stroops = 'NaN'::numeric OR (amount_stroops IS NOT NULL AND paid_amount_stroops < amount_stroops) OR redeemed_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM migration_audit_log mal 
      WHERE mal.challenge_id = challenges.id AND mal.migration_step = 'RECONCILE_UNPROVEN_REDEEMED'
    );

  UPDATE challenges
  SET status = 'RECONCILIATION_REQUIRED', paid_amount_stroops = CASE WHEN amount_stroops IS NOT NULL AND paid_amount_stroops < amount_stroops THEN NULL ELSE paid_amount_stroops END
  WHERE status = 'REDEEMED'
    AND (bound_tx_hash IS NULL OR paid_amount_stroops IS NULL OR paid_amount_stroops = 'NaN'::numeric OR (amount_stroops IS NOT NULL AND paid_amount_stroops < amount_stroops) OR redeemed_at IS NULL);
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

-- Migration evidence preservation table: records pre-sanitization values
CREATE TABLE IF NOT EXISTS migration_audit_log (
  id BIGSERIAL PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  migration_step TEXT NOT NULL,
  pre_status TEXT,
  pre_amount_stroops NUMERIC(40, 0),
  pre_paid_amount_stroops NUMERIC(40, 0),
  pre_amount_stroops_raw TEXT,
  pre_paid_amount_stroops_raw TEXT,
  pre_amount_text TEXT,
  pre_bound_tx_hash TEXT,
  sanitization_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- Explicit schema evolution for brownfield deployments where migration_audit_log already existed:
-- Harmonize column types to NUMERIC(40,0) if pre-existing columns had narrower precision (e.g. NUMERIC(38,0))
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_amount_stroops_raw TEXT;
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_paid_amount_stroops_raw TEXT;
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_amount_text TEXT;
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_bound_tx_hash TEXT;
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_amount_stroops NUMERIC(40, 0);
ALTER TABLE IF EXISTS migration_audit_log ALTER COLUMN pre_amount_stroops TYPE NUMERIC(40, 0);
ALTER TABLE IF EXISTS migration_audit_log ADD COLUMN IF NOT EXISTS pre_paid_amount_stroops NUMERIC(40, 0);
ALTER TABLE IF EXISTS migration_audit_log ALTER COLUMN pre_paid_amount_stroops TYPE NUMERIC(40, 0);
CREATE INDEX IF NOT EXISTS idx_migration_audit_challenge ON migration_audit_log(challenge_id);

COMMIT;
