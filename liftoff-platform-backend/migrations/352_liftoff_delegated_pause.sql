-- Migration 352: a Liftoff conversation can say that it is waiting on a person.
--
-- Liftoff can hand a turn to one of the workspace's AI teams, and that team can
-- stop mid-turn for a human approval. Until now that pause reached the person as
-- an SSE `error` frame and nothing else: it was never written down, so a reload
-- showed a truncated answer with no sign that anything was waiting, and everyone
-- else on the thread saw the conversation simply stop.
--
-- Team chat solved this already, with a persisted assistant row carrying
-- `message_type = 'hitl_status'` (migration 174 added the column to
-- agent_chat_messages). The frontend renders those rows as a quiet status line
-- rather than as speech. This column is the same idea on the same terms, so the
-- two surfaces share one vocabulary and one renderer instead of growing a second
-- mechanism for the same fact.
--
-- Nullable and sparse: ordinary speech stores NULL, which is what every row
-- written before this migration reads back as, and the repository maps NULL to
-- "an ordinary message" without any caller having to know.
ALTER TABLE liftoff_chat_messages
  ADD COLUMN message_type TEXT;

-- ── Finding the conversation from the colleague's side ─────────────────
--
-- A team that paused for an approval finishes its answer long after the Liftoff
-- turn ended, and the settle callback that delivers it knows only the thread the
-- approval was filed against, which is the TEAM'S thread. Carrying that reply
-- back into the conversation the person was actually reading therefore means
-- reading migration 349's pairing backwards, and that direction had no index:
-- the two unique indexes there are both keyed by liftoff_thread_id.
--
-- Not unique. The uniqueness that matters is already enforced from the other
-- side (one pairing per conversation per colleague), and a delegate thread that
-- somehow appeared under two conversations should degrade to picking one rather
-- than failing an insert on a table this one does not own.
CREATE INDEX idx_liftoff_delegation_delegate_thread
  ON liftoff_thread_delegations (delegate_thread_id, target_kind);
