-- Migration 557: what the vendor says it charged, per gateway request.
--
-- The token columns beside this one can be complete and the money still wrong,
-- and on one wire it always is. A model on OpenRouter is served by many endpoints
-- at different prices, and which one took a given request is not knowable from a
-- price list — so a charge reconstructed from tokens at the listed slug rate is
-- short by whatever premium the serving endpoint charges. The gap can be a
-- third of the charge or more, with every token count correct.
--
-- `usage.cost` on the response is the figure that sees it, because it IS the
-- charge. This column holds it, per request, at the moment of the request.
--
-- NULL MEANS "PRICE THIS FROM THE RATE TABLE", never zero. Every direct-API
-- vendor — Anthropic, OpenAI, Google, xAI — publishes a price list and reports no
-- per-call charge, so NULL is their normal and correct answer. A zero here would
-- silently un-bill a call, which is why the adapter only records a positive
-- figure.
--
-- NUMERIC rather than a float, and 10 decimal places, for the same reason as
-- `llm_usage_log.vendor_cost_usd` (migration 554): these are fractions of a cent
-- summed over millions of rows, which is exactly where binary floating point
-- drifts.
--
-- No backfill. A request already served cannot be re-asked what it cost.
--
-- No RLS change. `byok_gateway_requests` carries FORCE ROW LEVEL SECURITY and
-- keeps it: this adds a column and writes no rows.

ALTER TABLE byok_gateway_requests
  ADD COLUMN IF NOT EXISTS vendor_cost_usd NUMERIC(18,10);

COMMENT ON COLUMN byok_gateway_requests.vendor_cost_usd IS
  'What the vendor reported it charged for this request, as the vendor reported it. NULL when the vendor reports no per-call cost, which is every direct-API provider — treat NULL as "price from the rate table" and never as zero. The only figure that sees the endpoint spread on a gateway-served model.';
