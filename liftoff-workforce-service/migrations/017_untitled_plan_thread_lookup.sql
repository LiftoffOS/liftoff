-- Migration 017: a sanctioned cross-tenant read for the thread-title backfill.
--
-- Until today the CAIO carried its own fork of the thread-title generator. It
-- asked the model for prose and parsed it, so on a real exchange the model
-- fenced its JSON and the parse threw — every plan thread since the feature
-- shipped reads "Untitled Chat". The fork is gone (the shared generator in
-- @liftoffos/service-runtime runs now), but that only fixes threads from here
-- on. The rows already written need one pass over them.
--
-- The backfill is a sweep across every tenant, so there is no one tenant to
-- scope to and withTenantContext does not apply — the same shape as the
-- stuck-plan resumer in migration 015, and handled the same way rather than by
-- reaching for a raw pool. This function only enumerates candidates; the
-- per-thread reads and the title write both run inside withTenantContext, so
-- the definer's reach stops at (thread_id, tenant_id).
--
-- Migration 012 ENABLEs row security on team_plan_threads without FORCE, so the
-- owner (workforce_migrate, which created the table) is exempt. IF THAT TABLE IS
-- EVER SWITCHED TO FORCE, this stops returning rows — silently. Whoever makes that change owns fixing this with it.
--
-- The candidate set deliberately mirrors listThreads': a thread with no user
-- message is a greeting-only shell that the history modal already hides, and
-- titling those would spend a model call per row on something nobody can see.
-- `title_source IS DISTINCT FROM 'user'`
-- is belt-and-braces — updateThreadTitleInternal enforces it on the write too —
-- so a thread someone renamed by hand can never be reworded by a sweep.

BEGIN;

CREATE OR REPLACE FUNCTION workforce_find_untitled_plan_threads(
  max_rows INTEGER
)
RETURNS TABLE (thread_id UUID, tenant_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.tenant_id
  FROM team_plan_threads t
  WHERE t.deleted_at IS NULL
    AND (t.title IS NULL OR t.title = '')
    AND t.title_source IS DISTINCT FROM 'user'
    AND EXISTS (
      SELECT 1 FROM team_plan_messages m
      WHERE m.thread_id = t.id AND m.role = 'user'
    )
  ORDER BY t.updated_at DESC
  LIMIT max_rows
$$;

REVOKE ALL ON FUNCTION workforce_find_untitled_plan_threads(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workforce_find_untitled_plan_threads(INTEGER) TO workforce_app;

COMMIT;
