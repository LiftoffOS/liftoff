-- Keep the poisoned artifact instead of destroying it (C10).
--
-- `decideArtifactResume` distinguishes two failures. `fallback` means the
-- artifact belongs to a different engine — expected on a provider switch, and
-- already handled by a graceful cold start. `fail` means something is actually
-- wrong: a missing payload, a format version we do not know, or a checksum that
-- does not match the bytes.
--
-- On `fail` both callers DELETE the row. That is correct for the live path —
-- the poisoned artifact must not be handed to a resume again — but it destroys
-- the only evidence of a corruption we have never diagnosed. Checksum
-- mismatches in particular say something is wrong upstream of here, and there
-- is nothing left to look at.
--
-- So: move rather than delete. Same effect on the live path (the row is gone
-- from its source table), but the bytes and the envelope survive long enough
-- for someone to read them.
--
-- Not tenant-scoped, matching the tables it drains: neither `chat_sessions` nor
-- `agent_run_sessions` carries a tenant_id, because this runtime is already
-- per-tenant. Adding a scope here that its sources do not have would be a lie
-- about where isolation comes from.

BEGIN;

CREATE TABLE IF NOT EXISTS quarantined_session_artifacts (
  id             BIGSERIAL    PRIMARY KEY,
  -- 'chat_sessions' | 'agent_run_sessions'. Kept as free text rather than an
  -- enum so a third session store does not need a migration to be quarantined.
  source_table   TEXT         NOT NULL,
  -- The source row's identity, generically. chat_sessions is (thread_id,
  -- agent_id); agent_run_sessions is (trigger_key, agent_id). Text on both
  -- sides because trigger_key is not a UUID.
  key_a          TEXT         NOT NULL,
  key_b          TEXT         NOT NULL,

  sdk_session_id TEXT,
  jsonl_content  TEXT,

  -- The envelope as persisted, which is what the validator judged.
  execution_engine         TEXT,
  artifact_format          TEXT,
  artifact_format_version  INTEGER,
  producer_runtime_version TEXT,
  artifact_sha256          TEXT,

  -- Why it was rejected: the validator's failure class and its human reason.
  failure_class  TEXT,
  reason         TEXT,
  -- The engine the resume was attempting, which is half of any ownership
  -- mismatch and is not recoverable from the row alone.
  resume_engine  TEXT,

  quarantined_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The sweep reads by age; the operator reads by what broke.
CREATE INDEX IF NOT EXISTS idx_quarantined_artifacts_age
  ON quarantined_session_artifacts (quarantined_at);
CREATE INDEX IF NOT EXISTS idx_quarantined_artifacts_class
  ON quarantined_session_artifacts (failure_class, quarantined_at DESC);

COMMENT ON TABLE quarantined_session_artifacts IS
  'Session artifacts that failed resume validation (C10). Moved here instead of deleted so a corruption can be diagnosed. Swept at 30 days by the maintenance cron.';

COMMIT;
