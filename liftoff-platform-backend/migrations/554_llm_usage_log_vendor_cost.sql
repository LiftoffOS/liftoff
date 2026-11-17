-- Migration 554: what the vendor actually charged for a call, when it says so.
--
-- Every rate in the rate table is an ESTIMATE of a vendor's price list, and for the
-- gateway-served vendors the estimate cannot be made accurate in principle. A
-- model on OpenRouter is served by many endpoints at different prices — Kimi K3
-- by nineteen, spanning $1.03 to $4.50 per million input — and which one served
-- a given request is not knowable from a price list. `sync-model-pricing` takes
-- the MAX across endpoints, deliberately, because over-attributing is the safer
-- error when the true figure is unknowable. The cost of that safety is real: the
-- max sits about 2x the median, so the same call is attributed at roughly twice
-- what it cost.
--
-- It does not have to be unknowable. OpenRouter returns the actual charge on the
-- response — `usage.cost`, with `cost_details` splitting prompt from completion
-- and `provider` naming the endpoint that served it. This column holds that
-- figure, per call, at the moment of the call.
--
-- NULL means the vendor reported no cost, which is the normal case for every
-- direct-API provider (Anthropic, OpenAI, Google, xAI publish price lists, not
-- per-call charges). A reader must therefore treat NULL as "price it from the
-- rate table" and never as zero — a zero here would silently un-bill a call.
--
-- NUMERIC rather than a float: these are fractions of a cent (a short call
-- can cost a few millionths of a dollar) and they are summed over millions of
-- rows, which is exactly where binary floating point drifts. 10 decimal places carries a
-- sub-microdollar charge without rounding it away.
--
-- No backfill. A call already made cannot be re-asked what it cost, and the
-- estimate it was attributed at is what the customer was charged. Rows written
-- before this column keep NULL and keep pricing from the table, which is what
-- makes the change safe to deploy without a reconciliation pass.

ALTER TABLE llm_usage_log
  ADD COLUMN IF NOT EXISTS vendor_cost_usd NUMERIC(18,10);

COMMENT ON COLUMN llm_usage_log.vendor_cost_usd IS
  'What the vendor charged for this call, as the vendor reported it on the response. NULL when the vendor reports no per-call cost (every direct-API provider) — price those from the rate table. Never treat NULL as zero.';
