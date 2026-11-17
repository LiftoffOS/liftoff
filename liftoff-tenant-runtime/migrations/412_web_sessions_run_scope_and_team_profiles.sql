-- A team's browser is the team's.
--
-- A browser session has been a THREAD's: one live session per chat thread,
-- opened under the profile of the person on that thread. A scheduled or
-- delegated run has no thread and no person, so it could not open a browser
-- at all. It now may, and the session belongs to the RUN: keyed by the
-- invocation, one live session per invocation, closed when the run ends.
--
-- The login it carries belongs to the TEAM. A persistent profile has been one
-- per (team, person) — 'pane' — which gives a team nothing of its own to be
-- signed in as. A third kind, 'team', is one per team: every browser the team
-- opens, in its chat pane or on its own in a run, binds it, so a person who
-- signs the team in once has signed in its scheduled runs too.

ALTER TABLE web_sessions ADD COLUMN IF NOT EXISTS invocation_id UUID NULL;

COMMENT ON COLUMN web_sessions.invocation_id IS
  'The run this session belongs to, when a run rather than a thread opened it. '
  'A run-owned session has no thread_id and is closed when the run ends.';

-- One live browser per run, the same rule a thread has.
CREATE UNIQUE INDEX IF NOT EXISTS web_sessions_one_active_per_invocation
  ON web_sessions (tenant_id, invocation_id)
  WHERE closed_at IS NULL AND invocation_id IS NOT NULL;

-- The check from 298 was declared inline on the column, so its name is the
-- generated one. Dropped by lookup rather than by a guessed name.
DO $$
DECLARE
  con text;
BEGIN
  SELECT conname INTO con
  FROM pg_constraint
  WHERE conrelid = 'web_profiles'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%profile_kind%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE web_profiles DROP CONSTRAINT %I', con);
  END IF;
END $$;

ALTER TABLE web_profiles
  ADD CONSTRAINT web_profiles_profile_kind_check
  CHECK (profile_kind IN ('saved', 'pane', 'team'));

COMMENT ON COLUMN web_profiles.profile_kind IS
  'saved = a deliberate, per-site, named login; pane = one per (team, person), '
  'the profile behind a platform assistant''s browser pane; team = one per team, '
  'the profile behind every browser a team opens, in its pane or in a run.';
