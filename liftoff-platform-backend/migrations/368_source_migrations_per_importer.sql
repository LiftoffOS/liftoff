-- Liftoff Switch — an import belongs to a PERSON, not to a workspace.
--
-- Migration 361 keyed every migration on (tenant, source, fingerprint) and
-- recorded no importer at all. Three things followed from that, and all three
-- are wrong for a workspace with more than one person in it:
--
--   1. Two people in the same workspace whose installation sits at the same
--      path collided on ONE row. The fingerprint is sha256(source:path) with no
--      user or machine component, so `/root/.openclaw` on two servers — or the
--      same username on two laptops — produced the same value. The second
--      person's `switch` resumed the first person's migration and their bundle
--      upload overwrote it.
--   2. Nobody could tell whose import a row was, because the column did not
--      exist. Support, audit and the wizard all saw a workspace-level object.
--   3. The one-open-import rule counted per tenant, so one person importing
--      blocked everyone else in the workspace.
--
-- `account_id` is nullable: rows created before this migration have no importer
-- to attribute and inventing one would be a lie. The partial unique index below
-- treats NULL as distinct, which is the correct behaviour here — a legacy row
-- must not block a new per-person import of the same installation.

ALTER TABLE source_migrations
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);

COMMENT ON COLUMN source_migrations.account_id IS
  'The person whose machine this import came from. Null only for rows created before migration 368.';

-- Replace the workspace-scoped live index with a per-importer one.
--
-- Still partial on non-terminal states so a completed import does not block a
-- later re-import of the same installation, and still unique so re-running
-- `switch` resumes rather than starting a parallel migration for the SAME
-- person and the SAME installation.
DROP INDEX IF EXISTS idx_source_migrations_live;

CREATE UNIQUE INDEX idx_source_migrations_live
  ON source_migrations (tenant_id, account_id, source, installation_fingerprint)
  WHERE state NOT IN ('active', 'failed');

-- Support and the wizard both ask "what is this person importing", which is a
-- different question from "what is this workspace importing".
CREATE INDEX IF NOT EXISTS idx_source_migrations_account
  ON source_migrations (tenant_id, account_id, created_at DESC);
