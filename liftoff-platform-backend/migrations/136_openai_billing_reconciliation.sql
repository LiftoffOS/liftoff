-- OpenAI billing reconciliation table.
-- Mirror of anthropic_billing_reconciliation — one row per (date, purpose_group).
-- openai_cost_usd = -1 signals the OpenAI usage API was unavailable for that day.
CREATE TABLE openai_billing_reconciliation (
  date              DATE          NOT NULL,
  group_name        TEXT          NOT NULL,
  internal_cost_usd NUMERIC(18,8) NOT NULL,
  openai_cost_usd   NUMERIC(18,8) NOT NULL,
  discrepancy_usd   NUMERIC(18,8) NOT NULL DEFAULT 0,
  discrepancy_pct   NUMERIC(6,4),
  computed_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, group_name)
);
