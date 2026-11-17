-- Backfill: HRBP-created agents before the Phase 1 cost-attribution fix
-- have their distill LLM usage rows recorded with agent_id=NULL (because
-- HRBP didn't generate a sessionId + call attributeSessionToAgent). Those
-- rows currently land in "Platform analytics" on /insights instead of
-- under the created agent's "Creation" bucket.
--
-- We can identify HRBP-created agents by their idempotency key prefix
-- `workforce-plan:*` and link orphan distill rows by temporal proximity
-- (within 60 seconds before the agent's created_at).
--
-- Confidence: high. HRBP runs distill → createAgent sequentially; the
-- agent is inserted within seconds of distill completing. Parallel HRBP
-- runs for the same tenant shouldn't happen (service.approve triggers a
-- single sequential provisioner).
--
-- Idempotent: re-running is safe. The matched rows already have agent_id
-- set after the first run, so they no longer match the
-- `orphan.agent_id IS NULL` predicate.
--
-- This migration must run BEFORE migration 114 (distill → distill_update
-- relabel) so HRBP rows are attributed first and correctly counted as
-- the first distill for their agent (i.e. creation, not update).

WITH hrbp_agents AS (
  SELECT ia.id AS agent_id, ia.tenant_id, ia.created_at
  FROM internal_agents ia
  JOIN internal_agent_idempotency_keys iaik
    ON iaik.internal_agent_id = ia.id
    AND iaik.tenant_id = ia.tenant_id
  WHERE iaik.key LIKE 'workforce-plan:%'
),
-- DISTINCT ON (orphan.id) — for each orphan distill row, pick the single
-- closest-following HRBP agent (smallest positive time delta). Driving
-- the distinct-on from the orphan side guarantees each orphan appears at
-- most once in `matched`; if we instead drove it from the agent side, an
-- orphan that falls inside two agents' 60s windows could appear twice
-- and the UPDATE...FROM would pick one of the target agents
-- arbitrarily (implementation-defined Postgres behavior).
matched AS (
  SELECT DISTINCT ON (orphan.id)
    orphan.id AS orphan_row_id,
    ha.agent_id
  FROM llm_usage_log orphan
  JOIN hrbp_agents ha
    -- internal_agents.tenant_id is UUID; llm_usage_log.tenant_id is TEXT
    -- (migration 066 defined it as TEXT because the LLM tracker writes a
    -- stringified tenant id). Cast to text so the = operator resolves.
    ON ha.tenant_id::text = orphan.tenant_id
    AND orphan.timestamp BETWEEN (ha.created_at - INTERVAL '60 seconds')
                              AND ha.created_at
  WHERE orphan.purpose = 'distill'
    AND orphan.agent_id IS NULL
  ORDER BY orphan.id, (ha.created_at - orphan.timestamp) ASC
)
UPDATE llm_usage_log lul
SET agent_id = matched.agent_id
FROM matched
WHERE lul.id = matched.orphan_row_id;
