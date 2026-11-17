-- Phase 5 backfill: semantic-validation LLM calls run inside
-- distillInternalAgent within seconds of the main distill call for the
-- same tenant, but historically were logged with agent_id=NULL and
-- session_id=NULL (no attribution context was passed through). So their
-- cost has been leaking into Platform Analytics instead of the agent's
-- Creation / Updates bucket.
--
-- Phase 5 plumbs agentId/sessionId through to runSemanticValidator going
-- forward. This migration attempts to attribute historical rows to the
-- matching distill call by temporal proximity (same tenant, within 30
-- seconds, prefer the earliest preceding distill).
--
-- Confidence: very high. Semantic validation always runs inside
-- distillInternalAgent's call sequence; they share a tenant and fire
-- within seconds. Parallel distills for the same tenant are unlikely
-- (HRBP is sequential; team builder is user-driven).
--
-- Idempotent: rows that already have agent_id or session_id set no
-- longer match the WHERE clause, so re-running is a no-op.
--
-- Runs AFTER migration 114 so distill → distill_update relabeling has
-- already happened, letting us mirror the parent distill's purpose into
-- distill_semantic_validation vs distill_semantic_validation_update.

WITH matched AS (
  SELECT DISTINCT ON (sv.id)
    sv.id AS sv_id,
    d.agent_id AS matched_agent_id,
    d.session_id AS matched_session_id,
    d.purpose AS matched_distill_purpose
  FROM llm_usage_log sv
  JOIN llm_usage_log d
    ON d.tenant_id = sv.tenant_id
    AND d.purpose IN ('distill', 'distill_update')
    AND d.timestamp BETWEEN (sv.timestamp - INTERVAL '30 seconds')
                        AND (sv.timestamp + INTERVAL '5 seconds')
  WHERE sv.purpose = 'distill_semantic_validation'
    AND sv.agent_id IS NULL
  ORDER BY sv.id, ABS(EXTRACT(EPOCH FROM (d.timestamp - sv.timestamp)))
)
UPDATE llm_usage_log lul
SET
  agent_id = matched.matched_agent_id,
  session_id = COALESCE(lul.session_id, matched.matched_session_id),
  purpose = CASE matched.matched_distill_purpose
    WHEN 'distill_update' THEN 'distill_semantic_validation_update'
    ELSE 'distill_semantic_validation'
  END
FROM matched
WHERE lul.id = matched.sv_id;
