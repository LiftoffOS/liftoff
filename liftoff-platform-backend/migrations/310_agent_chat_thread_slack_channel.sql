-- 310_agent_chat_thread_slack_channel.sql
--
-- Self-wake settlement (plan §5.1): a slack-origin wake continuation must be ACTIVELY posted back to
-- the originating Slack thread. Posting needs BOTH the thread_ts (already stored as
-- agent_chat_threads.external_thread_ref) AND the Slack channel id — but the channel was never
-- persisted per-thread (findOrCreateThread stores only the thread_ts). Teams already stores the
-- full conversationId in external_thread_ref, so no equivalent is needed there.
--
-- Additive, nullable, idempotent. NO index / constraint / RLS change: agent_chat_threads keeps its
-- tenant_isolation policy (migration 105) and the (tenant_id, channel, external_thread_ref) unique
-- index is untouched — the thread identity is still the thread_ts.
ALTER TABLE agent_chat_threads
  ADD COLUMN IF NOT EXISTS slack_channel_id TEXT;

COMMENT ON COLUMN agent_chat_threads.slack_channel_id IS
  'Slack channel id for a slack-origin thread (populated by the slack chat worker). Needed to actively post a self-wake continuation back to the thread (plan §5.1). NULL for non-slack threads.';

-- ── wake_settlement_ledger: idempotent delivery keyed by wakeId (plan §5.1) ──
-- TR settles each wake exactly once via its fenced lease, but the TR->PB settlement callback can be
-- retried (transport error, TR reclaim). Without a ledger a retry double-posts the continuation. The
-- settlement handler CLAIMs a row here first (ON CONFLICT DO NOTHING); a duplicate finds the row and
-- returns delivered without re-posting. On a delivery failure the handler RELEASES the claim (deletes
-- the row) so a genuine retry re-drives delivery. Tenant-scoped column; no RLS (service-auth endpoint,
-- explicit tenant_id filter) — matches the wake tables' non-RLS posture in TR.
CREATE TABLE IF NOT EXISTS wake_settlement_ledger (
  wake_id      TEXT PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
