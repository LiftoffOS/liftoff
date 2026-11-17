-- Migration 134: Fix cost_attribution_snapshots uniqueness for NULL agent_id
--
-- The UNIQUE (tenant_id, agent_id, period_start, granularity) constraint from
-- migration 133 is non-functional for rows where agent_id IS NULL: PostgreSQL
-- UNIQUE indexes do not treat NULL values as equal, so multiple
-- (tenant_id, NULL, period_start, granularity) rows can coexist, causing
-- duplicate tenant-level snapshots on every hourly rollup.
--
-- Fix: drop the constraint and replace with two partial unique indexes —
-- one for the agent-scoped case (agent_id IS NOT NULL) and one for the
-- tenant-level case (agent_id IS NULL).

DO $$
DECLARE
  cname TEXT;
BEGIN
  -- Find the 4-column UNIQUE constraint (the one created by migration 133).
  -- Auto-generated name is truncated by Postgres, so we identify it by
  -- column count rather than guessing the exact truncated name.
  SELECT conname INTO cname
  FROM pg_constraint c
  WHERE c.conrelid = 'cost_attribution_snapshots'::regclass
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 4;

  IF cname IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE cost_attribution_snapshots DROP CONSTRAINT %I',
      cname
    );
  END IF;
END $$;

-- Partial unique index for agent-level snapshots (agent_id NOT NULL).
-- ON CONFLICT can reference this using the WHERE predicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cas_agent_period_uniq
  ON cost_attribution_snapshots (tenant_id, agent_id, period_start, granularity)
  WHERE agent_id IS NOT NULL;

-- Partial unique index for tenant-level snapshots (agent_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cas_noagent_period_uniq
  ON cost_attribution_snapshots (tenant_id, period_start, granularity)
  WHERE agent_id IS NULL;
