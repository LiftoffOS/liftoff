-- Template ids follow the display name, so the stored provenance has to move with them.
--
-- `internal_agents.template_id` is what `templateIdForRedistill` hands back to
-- `getTemplate()`. A stale id resolves to nothing, and the loader's response to
-- nothing is to log a warning and distil WITHOUT the template seed — so a
-- redistilled agent would quietly lose its column contract, its picks and its
-- trigger topics, and still look like a successful redistill. For
-- cp-checklist-analyst that specifically means losing the row definition that
-- makes it emit tabular_enumerate rather than tabular_extract. That is the whole
-- reason this is a migration and not a note in a changelog.
--
-- Renames only. Every agent keeps its `template_source_hash`, which is taken
-- over responsibilities + additionalContext and is unaffected by an id or a
-- display name changing: an agent whose prose is still ours stays redistillable
-- across this rename, and one whose prose was edited stays correctly excluded.
--
-- RLS, following migration 360: internal_agents is FORCE row-level-security
-- (migration 287) and migrations run as liftoff_app, which has no BYPASSRLS. The
-- tenant policy reads current_setting('app.current_tenant_id') with no
-- missing_ok, so with no GUC set this raises 42704 and aborts — which is exactly
-- how the first attempt at this migration failed — and with one set it would
-- reach a single tenant, when a template rename is global. Dropping FORCE for
-- the length of this transaction is the owner's equivalent of the admin pool's
-- BYPASSRLS; ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other
-- session ever observes the table unforced.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents SET template_id = v.new_id
FROM (VALUES
  ('cp-associate',                    'cp-checklist-analyst'),
  ('credit-agreement-associate',      'credit-agreement-memo-writer'),
  ('ediscovery-analyst',              'e-discovery-analyst'),
  ('executive-briefing-manager',      'executive-presentation-specialist'),
  ('incident-triage-agent',           'incident-triage-specialist'),
  ('lpa-analyst',                     'limited-partnership-agreement-analyst'),
  ('shareholder-agreement-associate', 'shareholder-agreement-memo-writer')
) AS v(old_id, new_id)
WHERE internal_agents.template_id = v.old_id;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
