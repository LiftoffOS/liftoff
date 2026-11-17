-- Migration 435: mcp_chat_runs can address the platform assistants
--
-- liftoff_chat now reaches the Liftoff assistant, the Chief AI Officer and the
-- Insights Manager, not only the workspace AI teams. An assistant conversation
-- lives on that assistant's own surface (liftoff_chat_threads,
-- insights_chat_threads, or a workforce-service team-plan thread), so the run
-- row must be able to point at a thread that is not an agent_chat_threads row
-- and at a target that is not an internal_agents row.

-- ── Which surface the run executes on ──────────────────────────────────────
--
-- 'team' is the existing agent-chat path and stays the default, so every
-- pre-existing row keeps its meaning without a backfill.
ALTER TABLE mcp_chat_runs ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'team';
ALTER TABLE mcp_chat_runs ADD CONSTRAINT mcp_chat_runs_target_kind_check
  CHECK (target_kind IN ('team', 'liftoff', 'insights', 'caio'));

-- ── The assistant's reply, durably local ───────────────────────────────────
--
-- A Chief AI Officer reply is only observable from its stream: the message row
-- it persists lives in workforce-service's database, which this service cannot
-- read. The run row is therefore the one local record the long-poll can serve.
-- Liftoff and Insights runs use the same column so the read path has one
-- branch, not three; team runs keep assistant_message_id and leave this NULL.
ALTER TABLE mcp_chat_runs ADD COLUMN reply_content TEXT;

-- ── agent_id belongs to team runs only ─────────────────────────────────────
--
-- The assistants are not internal_agents rows (the CAIO's row is a
-- tenant_id-NULL system agent; the other two are not rows anywhere), so an
-- assistant run carries no agent_id. The CHECK keeps the two facts in lockstep
-- in both directions.
ALTER TABLE mcp_chat_runs ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE mcp_chat_runs ADD CONSTRAINT mcp_chat_runs_agent_id_matches_kind
  CHECK ((target_kind = 'team') = (agent_id IS NOT NULL));

-- ── thread_id loses its FK, keeps NOT NULL ─────────────────────────────────
--
-- A CAIO run's thread id names a row in another service's database, and a
-- cross-database id must never be FK'd locally (ADR-049). Liftoff and Insights
-- threads live in tables of their own, and one column cannot reference three
-- parents conditionally. The insert paths validate thread existence
-- in-transaction for local kinds instead. Dropped by lookup rather than by
-- guessed name so a drifted constraint name fails loudly here, not silently.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'mcp_chat_runs'::regclass
    AND contype = 'f'
    AND confrelid = 'agent_chat_threads'::regclass;
  IF fk_name IS NULL THEN
    RAISE EXCEPTION 'mcp_chat_runs foreign key to agent_chat_threads not found';
  END IF;
  EXECUTE format('ALTER TABLE mcp_chat_runs DROP CONSTRAINT %I', fk_name);
END $$;

-- Pure DDL throughout: nothing reads or writes a row, so no NO FORCE / FORCE
-- ROW LEVEL SECURITY escape is needed, and the CHECK validations are direct
-- heap scans that row security does not apply to (unlike a validated FK on an
-- RLS-forced referenced table, which is the trap this file avoids by only
-- DROPPING one). The partial unique index idx_mcp_chat_runs_one_active_per_thread
-- is on thread_id alone and keeps enforcing one active run per conversation
-- across every target kind.
