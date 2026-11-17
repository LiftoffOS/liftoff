-- Migration 213 — backfill historic cost_attribution_events that should
-- now be classified as platform_overhead.
--
-- Why this exists: migration 210 ran BEFORE the chargeability classifier
-- (src/cost-attribution/event-classification.ts) was introduced. Every
-- pre-existing row got bucketed as 'included' / 'precommit' / 'reload'
-- according to the per-tenant rates, including platform-internal LLM
-- consumption (CAIO/HRBP/distillation/capability_analysis/insights chat)
-- that we now Liftoff-absorb. Without this backfill:
--
--   1. /insights would keep displaying non-zero customer_cost_usd for those
--      events. The data-providers correctly filter cost_bucket <>
--      'platform_overhead' going forward; we just need the historic bucket
--      labels to match so that filter works.
--
--   2. Ops queries that look up "platform overhead by tenant" would miss
--      gcp_billing_platform rows written with cost_bucket='unknown' before
--      the gcp-billing-ingester fix landed. (Their customer_cost_usd was
--      already 0, so no customer-facing impact, just ops visibility.)
--
-- We do NOT touch billing_controls.ous_consumed_this_period:
--
--   - 206b's counter sync (Step 2) reads from billing_spend_events only.
--     billing_spend_events is tenant_runtime-only; it has no platform_llm
--     rows and no gcp_billing_platform rows. So the historic counter never
--     had platform-overhead consumption in it to begin with.
--
--   - For new consumption written between the 206/206b deploy and the
--     classifier deploy (a window that does not exist in this worktree —
--     they ship together — but might exist if PR1 shipped standalone), we
--     could over-count. To guard that case defensively without depending on
--     deploy timing, we resync the counter at the end to the canonical
--     "sum of customer-chargeable ou_consumed in the current period." That
--     matches what runtime code now produces.
--
-- We do NOT credit back reload_balance_usd for historic reload-bucket
-- platform-overhead consumption. Pre-fix the drain never fired in the
-- ingester paths (Loss A); the wallet was never debited; there is nothing
-- to credit. Going forward the drain works correctly via applyReloadDrain.
--
-- Idempotent: re-running finds zero rows to update (the WHERE clauses
-- exclude already-platform_overhead rows) and the counter resync is
-- itself idempotent.

BEGIN;

-- ── Step 1 — reclassify platform_llm rows that match the new criteria.
-- Logic mirrors src/cost-attribution/event-classification.ts.
UPDATE cost_attribution_events
   SET cost_bucket       = 'platform_overhead',
       customer_cost_usd = 0
 WHERE cost_bucket <> 'platform_overhead'
   AND source = 'platform_llm'
   AND (
     -- (a) platform_llm with a known platform-overhead purpose (regardless
     -- of agent_id — injection_guard always carries an agent_id but is
     -- still platform middleware).
     purpose IN (
       'distill', 'distill_update',
       'distill_semantic_validation', 'distill_semantic_validation_update',
       'capability_analysis', 'manual_capability_analysis',
       'caio_workforce_planning',
       'caio_workforce_planning_summarization',
       'caio_workforce_planning_title_generation',
       'insights_chat', 'insights_summarization',
       'insights_observation', 'insights_intro',
       'injection_guard', 'rolling_summary', 'title_generation'
     )
     -- (b) platform_llm with NO agent_id and a non-customer-interaction
     -- purpose (or no purpose) — the /insights chat path emits these.
     OR (agent_id IS NULL AND (purpose IS NULL OR purpose NOT IN (
         'agent_chat', 'agent_chat_summarization',
         'context_absorption', 'thread_title_generation',
         'chat-feedback-extraction'
       )))
   );

-- ── Step 2 — fix gcp_billing_platform rows. These were written before the
-- gcp-billing-ingester switched from cost_bucket='unknown' to 'platform_overhead'.
-- customer_cost_usd is already 0 on these (the ingester always set that), so
-- no zeroing is needed; we just relabel the bucket so ops queries find them.
UPDATE cost_attribution_events
   SET cost_bucket = 'platform_overhead'
 WHERE source = 'gcp_billing_platform'
   AND cost_bucket = 'unknown';

-- ── Step 3 — resync billing_controls.ous_consumed_this_period to the
-- in-period customer-chargeable consumption.
--
-- Source of truth: billing_spend_events (tenant_runtime via spend-subscriber).
-- Every other customer-chargeable source writes to cost_attribution_events
-- only, so we ALSO add their in-period contribution. The cost_bucket filter
-- excludes platform_overhead and unknown so the resync reflects only what
-- the customer is being charged for.
--
-- This matches the runtime invariant: the counter equals the sum of
-- ou_consumed across customer-chargeable cost_attribution_events rows in
-- the current period. After this resync the counter is correct regardless
-- of when the classifier shipped relative to PR 1.
UPDATE billing_controls bc
   SET ous_consumed_this_period = COALESCE(in_period.delta, 0)
  FROM (
    SELECT t.account_id,
           SUM(cae.ou_consumed) AS delta
      FROM cost_attribution_events cae
      -- cost_attribution_events.tenant_id is TEXT (migration 133); tenants.id
      -- is UUID — cast tenants.id to text so the join compares same types.
      JOIN tenants t            ON t.id::text     = cae.tenant_id
      JOIN billing_controls bc2  ON bc2.account_id = t.account_id
     WHERE cae.cost_bucket NOT IN ('platform_overhead', 'unknown')
       AND bc2.billing_period_start IS NOT NULL
       AND cae.occurred_at >= bc2.billing_period_start
     GROUP BY t.account_id
  ) in_period
 WHERE bc.account_id = in_period.account_id;

COMMIT;
