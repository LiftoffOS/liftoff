-- A platform assistant's browser is the workspace's.
--
-- 412 gave a team one persistent browser profile of its own. A platform
-- assistant — Liftoff, the Chief AI Officer, the Insights Manager — has no
-- team, and its conversations are the workspace's just as a team's are: any
-- member can open a thread, several people take part in one, and the browser
-- pane beside it is one session everyone in the thread drives. The persisted
-- profile behind that pane was keyed to whoever opened it first, so its logins
-- were one person's, carried into a shared space, and absent from a
-- colleague's new thread. An assistant now has one profile per workspace.
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
  CHECK (profile_kind IN ('saved', 'pane', 'team', 'assistant'));

COMMENT ON COLUMN web_profiles.profile_kind IS
  'saved = a deliberate, per-site, named login; team = one per team, the profile '
  'behind every browser a team opens, in its pane or in a run; assistant = one per '
  'platform assistant per workspace, the profile behind every browser that assistant '
  'opens; pane = the legacy per-person profile, kept for a caller naming neither.';
