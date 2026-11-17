-- Late feedback support for the human_feedback table.
--
-- Platform Backend's hitl-late-feedback module forwards a feedback row to
-- the runtime via POST /api/hitl-enforcement/late-feedback when a human
-- resolves a HITL approval AFTER it expired (the agent already moved on).
-- The runtime stores the decision in human_feedback so the reflection
-- engine picks it up via getHumanFeedback() during its next learning pass.
--
-- Two columns are added:
--
-- 1. feedback_id (UNIQUE) — the idempotency key from Platform Backend.
--    sendLateFeedback retries with exponential backoff (1s/2s/4s/8s/16s)
--    plus a background sync job; without an idempotency key a successful
--    write whose response was lost in transit would be re-applied on every
--    retry, polluting reflection signals with duplicate weight. The unique
--    constraint lets the insert use ON CONFLICT (feedback_id) DO NOTHING.
--
-- 2. tenant_id — the original schema in 001_initial_schema.sql relied on
--    transitive isolation through agents.tenant_id, but the reflection
--    engine repository queries human_feedback by agent_id only, with no
--    tenant scoping at the query level. Adding tenant_id directly lets the
--    late-feedback insert and any future reflection-side query filter by
--    tenant_id explicitly, which is the convention every other table in
--    this repo follows. Backfilled from agents.

ALTER TABLE human_feedback
  ADD COLUMN IF NOT EXISTS feedback_id UUID,
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Backfill tenant_id from the agent.
UPDATE human_feedback hf
   SET tenant_id = a.tenant_id
  FROM agents a
 WHERE hf.tenant_id IS NULL
   AND a.id = hf.agent_id;

-- Enforce idempotency on the upstream key. NULL is allowed for legacy rows
-- (which were created without a feedback_id) so the constraint applies only
-- to new late-feedback writes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_feedback_feedback_id
  ON human_feedback (feedback_id)
  WHERE feedback_id IS NOT NULL;

-- Reflection engine queries human_feedback by agent_id ORDER BY created_at
-- DESC, but adding tenant_id makes it possible to add a tenant filter on
-- the same lookup path without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_human_feedback_tenant_agent_created
  ON human_feedback (tenant_id, agent_id, created_at DESC);
