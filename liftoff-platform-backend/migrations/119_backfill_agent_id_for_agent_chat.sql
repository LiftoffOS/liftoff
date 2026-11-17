-- Backfill agent_id on historical agent_chat llm_usage_log rows so they show
-- up correctly in the new per-agent "interactions" bucket on /insights.
--
-- Before this migration's companion code change, src/agent-chat/chat-service.ts
-- emitted purpose='agent_chat' rows without setting agent_id in usageContext,
-- so the cost was lumped into platformLLMOperations alongside unrelated
-- insights chat traffic.
--
-- Strategy: per orphan agent_chat row, find the closest assistant-message
-- written in the same tenant within a small temporal window. If the thread
-- has exactly one participating agent, attribute the orphan to that agent.
-- Multi-agent threads are skipped (their attribution is ambiguous and would
-- need turn-level reconstruction).
--
-- Confidence: high for single-agent threads (the dominant case); zero for
-- multi-agent threads (intentionally left with agent_id=NULL).
--
-- Idempotent: re-running is safe. Matched rows already have agent_id set
-- after the first run, so they no longer satisfy `orphan.agent_id IS NULL`.
--
-- Cross-table join cast: llm_usage_log.tenant_id is TEXT (migration 066);
-- agent_chat_messages.tenant_id is UUID (migration 105). Cast to text so
-- the equality resolves — same pattern as migration 113.

WITH matched AS (
  SELECT DISTINCT ON (orphan.id)
    orphan.id AS orphan_row_id,
    sub.agent_id
  FROM llm_usage_log orphan
  JOIN LATERAL (
    SELECT p.agent_id
    FROM agent_chat_messages m
    JOIN agent_chat_thread_participants p ON p.thread_id = m.thread_id
    WHERE m.tenant_id::text = orphan.tenant_id
      AND m.role = 'assistant'
      AND m.created_at >= orphan.timestamp - INTERVAL '5 seconds'
      AND m.created_at <= orphan.timestamp + INTERVAL '60 seconds'
    GROUP BY m.thread_id, p.agent_id
    HAVING COUNT(DISTINCT p.agent_id) = 1
    ORDER BY MIN(ABS(EXTRACT(EPOCH FROM (m.created_at - orphan.timestamp))))
    LIMIT 1
  ) sub ON true
  WHERE orphan.purpose = 'agent_chat'
    AND orphan.agent_id IS NULL
    AND orphan.success = true
)
UPDATE llm_usage_log lul
SET agent_id = matched.agent_id
FROM matched
WHERE lul.id = matched.orphan_row_id;
