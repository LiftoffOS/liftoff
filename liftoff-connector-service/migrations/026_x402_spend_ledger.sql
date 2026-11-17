-- x402 spend ledger — the daily treasury counter behind x402SpendGuard.
--
-- One row per (UTC day, connector type), accumulating the USD value of USDC
-- micropayments the platform x402 wallet settled that day. Read before each
-- payment to enforce the global and per-vendor daily ceilings; written after
-- each settled payment. This is a WALLET-DRAIN guard on the platform's own
-- funds, not a cap on what an agent may do — agent execution is never gated
-- on it (the refused call fails like any vendor refusal and the agent
-- continues).
--
-- Platform treasury data: no tenant dimension, so no RLS. The global daily
-- total is SUM(spent_usd) over a day's rows.

BEGIN;

CREATE TABLE IF NOT EXISTS x402_spend_ledger (
  day            DATE        NOT NULL,
  connector_type TEXT        NOT NULL,
  spent_usd      NUMERIC(14, 6) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, connector_type)
);

GRANT SELECT, INSERT, UPDATE ON TABLE x402_spend_ledger TO connector_admin;

COMMIT;
