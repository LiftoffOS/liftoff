-- 423: one recorder of pane browser activity, for every surface.
--
-- A person who drives the browser beside a conversation and then asks to
-- automate what they did needs the work record to hold every browser call
-- that happened there, whoever made it: a team's own tool path, or a platform
-- assistant (Liftoff, the Insights Manager, the Chief AI Officer) over the
-- BrowserSessionsService RPCs. Until now the runtime returned a team's trail
-- beside the tool result and it ended there, and only the Liftoff surface
-- kept its own rows in the control plane. This runtime is the ONE side that
-- has a team's trail and it already owns the takeover holds (418), so it is
-- the one recorder.
--
-- The rule: one row per recorded pane work call on a thread once a browser
-- session has been resolved, whoever made it. Work is a navigation, a browser
-- task, a page read, a save as PDF, a screenshot, a download listing or
-- fetch. Operational probes (intervention pending, session stats) and a plain
-- session start are not work and are not recorded. Run-scoped calls (an
-- unattended run's sandbox browser) are not recorded here: no thread, no
-- pane, no takeover; the run's own activity log is its record. A failure
-- before any session exists has no browser behaviour to replay and is logged
-- rather than represented as a row; a failure AFTER session resolution is
-- recorded under the caller's id before the error is thrown.
--
-- id is the CALLER's and is never defaulted. The control plane mints a UUID
-- per call and sends it on the request; the runtime's own tool path mints
-- one itself. The insert is ON CONFLICT (id) DO NOTHING, which is what makes
-- a retried or replayed call write once, and what lets the control plane's
-- fallback row (written under the same id when an answer never arrived) lose
-- to this row by exact id in the reader's merge.
--
-- Every text column has passed the protected data policy before it is
-- written: instruction and outcome through the browser text sanitizer, a
-- step's page URL through the safe URL projection. Ordinary entered values
-- (a search term, a filter, a record name, a business email) are retained
-- because an AI team that mirrors the person's workflow needs them; an
-- identified authentication, payment, high-risk identity or file value is
-- omitted with its class. The *_truncated and *_protected_data_omitted flags
-- say what that pass changed, so a reader never presents a cut or redacted
-- text as exact. steps is NULL when the tool has no step sequence (a
-- navigation, a read); a browser task carries an array, empty when the loop
-- ran and took none, and capture_gap / gap_reason say when observation was
-- incomplete. gap_reason is a closed, product-safe vocabulary, never raw
-- exception, vendor or session text.
--
-- Retention: rows follow the conversation data lifecycle. A soft-deleted
-- conversation's rows are unreadable (the control plane's reader refuses the
-- thread) but retained like its messages; tenant deletion deletes the
-- session and cascades this table and the takeover tables through
-- web_sessions.

CREATE TABLE browser_activity (
  id                                  UUID PRIMARY KEY,
  tenant_id                           UUID NOT NULL,
  thread_id                           UUID,
  session_id                          UUID NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  tool                                TEXT NOT NULL,
  instruction                         TEXT,
  outcome                             TEXT,
  person_took_over                    BOOLEAN NOT NULL DEFAULT FALSE,
  steps                               JSONB,
  instruction_truncated               BOOLEAN NOT NULL DEFAULT FALSE,
  outcome_truncated                   BOOLEAN NOT NULL DEFAULT FALSE,
  capture_gap                         BOOLEAN NOT NULL DEFAULT FALSE,
  gap_reason                          TEXT CHECK (gap_reason IN (
                                        'attach_failed', 'frame_unavailable', 'disconnected',
                                        'cap', 'reconciliation_uncertain'
                                      )),
  steps_truncated                     BOOLEAN NOT NULL DEFAULT FALSE,
  instruction_protected_data_omitted  BOOLEAN NOT NULL DEFAULT FALSE,
  outcome_protected_data_omitted      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Millisecond precision: the page cursor carries this value through a
  -- JavaScript Date, so the stored value must round-trip exactly or two rows
  -- written in the same millisecond could be skipped between pages.
  created_at                          TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT browser_activity_gap_reason_iff_gap
    CHECK (capture_gap = (gap_reason IS NOT NULL))
);
CREATE INDEX browser_activity_thread ON browser_activity (thread_id, created_at DESC, id DESC);

-- Tenant policy as migration 418 writes it, FORCEd so the owning role is
-- bound by it too; every query runs under withTenantScope.
ALTER TABLE browser_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_activity_tenant ON browser_activity
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE browser_activity IS
  'One row per recorded pane work call on a thread''s browser once a session was resolved, whoever made it (a team''s tool path or a platform assistant over RPC). Run-scoped calls are not recorded. id is the caller''s; ON CONFLICT (id) DO NOTHING makes a retried call write once. Every text has passed the protected data policy; the flags say what changed. Rows follow the conversation lifecycle: retained on soft delete, cascaded on tenant deletion through web_sessions.';
COMMENT ON COLUMN browser_activity.id IS
  'The caller''s activity id, minted per call; never defaulted.';
COMMENT ON COLUMN browser_activity.steps IS
  'NULL when the tool has no step sequence; a browser task carries an array (empty when the loop took no step), each step already bounded and through the safe URL projection.';
COMMENT ON COLUMN browser_activity.gap_reason IS
  'Closed vocabulary; non-null exactly when capture_gap. Never raw exception, vendor or session text.';

-- The cached pane URL in web_sessions.vendor_metadata was written raw before
-- this landed, tokens and all. From this release the writer persists the safe
-- projection (recordedUrl) and the next page-state or tool touch repopulates
-- the key; the pre-deploy residue is removed here rather than claimed clean.
-- Live vendor sessions and credentials are untouched: only the one cached key
-- goes, and the session stays open. web_sessions carries no row security
-- (src/__tests__/known-unprotected-tenant-tables.ts), so the cross-tenant
-- write needs no NO FORCE / FORCE pair around it: the pair is for a table
-- whose FORCEd policy would bind the owning role, and writing it here would
-- leave a table with no policy marked forced, which the RLS ratchet
-- (rls-coverage.ts) reads as protection that does not exist.
UPDATE web_sessions
   SET vendor_metadata = vendor_metadata - 'current_url'
 WHERE vendor_metadata ? 'current_url';
