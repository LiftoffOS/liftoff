-- 438: record what the gateway charged for an invocation, beside the rates it
-- would otherwise be priced at.
--
-- The invocation row stores TOKENS and a RATE SNAPSHOT, and every reader that
-- needs money multiplies the two. That is exact for a direct-API vendor, which
-- publishes a price list, and cannot be right for a gateway-served model: one
-- model is served by many endpoints at different prices (glm-5.2 by thirty-two,
-- $0.4886 to $2.3100 per million input) and no price list says which one took
-- the request. `sync-model-pricing` resolves that with the max across endpoints,
-- so a run repriced from the snapshot is charged the dearest endpoint's rate.
--
-- `priceRunSteps` already prefers the reported charge and publishes it on
-- `invocation.completed`, so the PRIMARY billing path carries the right number.
-- The BACKSTOP does not: `listInvocationsForIngestion` recomputes cost from this
-- row's tokens and rates, so a run the event path missed is reconciled at up to
-- the endpoint maximum. This column is what lets that path agree with the other
-- one instead of silently disagreeing with it.
--
-- NULL means "no gateway reported a charge, price it from the rates" and is the
-- NORMAL case — Anthropic, OpenAI, Google and xAI report no per-call charge.
-- Never zero: a zero booked as a charge is an unbilled call.

ALTER TABLE invocations
  ADD COLUMN IF NOT EXISTS vendor_cost_usd NUMERIC(18,10);

COMMENT ON COLUMN invocations.vendor_cost_usd IS
  'What the gateway charged for this invocation, summed over its steps, where one reported a charge (OpenRouter''s usage.cost, opencode''s step cost). NULL means price it from the rate snapshot; never 0.';
