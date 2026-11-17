-- Make anthropic_billing_reconciliation match the reconciler that writes it, and
-- give it somewhere to put tokens.
--
-- Migration 136 calls openai_billing_reconciliation a "Mirror of
-- anthropic_billing_reconciliation" and is not one: it renamed purpose_group to
-- group_name, reconciled_at to computed_at, added discrepancy_usd, and made
-- discrepancy_pct nullable. The Anthropic reconciler was later written against
-- that newer shape, so its INSERT names three columns this table does not have,
-- targets a conflict key that is not its primary key, and passes NULL into a NOT
-- NULL column. The table has never held a row.
--
-- Why tokens as well as dollars: reconciliation is per purpose group, and each
-- group already has its own Anthropic API key. Anthropic reports dollars only
-- per workspace or description (`cost_report`); per API key it reports TOKENS
-- (`usage_report/messages`, group_by=api_key_id). So the per-group comparison is
-- on tokens, and anthropic_cost_usd holds the ORGANISATION-WIDE dollar figure for
-- that date — the same value on each of the day's rows, because it is not
-- divisible by group. Comparing a per-group internal cost against it would be a
-- category error, which is what the code did.
--
-- Idempotent: renames are guarded, adds use IF NOT EXISTS. No existing rows are
-- rewritten.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'anthropic_billing_reconciliation'
       AND column_name  = 'purpose_group'
  ) THEN
    ALTER TABLE anthropic_billing_reconciliation
      RENAME COLUMN purpose_group TO group_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'anthropic_billing_reconciliation'
       AND column_name  = 'reconciled_at'
  ) THEN
    ALTER TABLE anthropic_billing_reconciliation
      RENAME COLUMN reconciled_at TO computed_at;
  END IF;
END $$;

ALTER TABLE anthropic_billing_reconciliation
  ADD COLUMN IF NOT EXISTS discrepancy_usd NUMERIC(18,8) NOT NULL DEFAULT 0;

-- NULL is the honest value when Anthropic reported nothing to compare against.
-- The sibling table already allows it.
ALTER TABLE anthropic_billing_reconciliation
  ALTER COLUMN discrepancy_pct DROP NOT NULL;

-- Per-group token totals: ours from cost_attribution_events, Anthropic's from
-- usage_report grouped by api_key_id. Anthropic's are nullable because a run
-- with no admin credential legitimately has no vendor side.
ALTER TABLE anthropic_billing_reconciliation
  ADD COLUMN IF NOT EXISTS internal_input_tokens   BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS internal_output_tokens  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anthropic_input_tokens  BIGINT,
  ADD COLUMN IF NOT EXISTS anthropic_output_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS token_discrepancy_pct   NUMERIC(6,4);

COMMENT ON COLUMN anthropic_billing_reconciliation.anthropic_cost_usd IS
  'Organisation-wide Anthropic cost for this date, from /v1/organizations/cost_report. NOT per group: Anthropic cannot break dollars down by API key, so the same value repeats on every group row for the date. -1 means the report was unavailable.';
COMMENT ON COLUMN anthropic_billing_reconciliation.token_discrepancy_pct IS
  'Per-group token discrepancy: |internal - anthropic| / anthropic, over input+output tokens. This is the per-group signal; the dollar columns are organisation-wide.';
