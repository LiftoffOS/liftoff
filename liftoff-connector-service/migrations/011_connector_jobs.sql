-- Migration 011: Async job tracking for long-running connector operations.
--
-- Operations like create-from-template (4-5 sequential Google API calls)
-- exceed the Cloud Run request timeout when done synchronously. Instead,
-- callers receive a 202 + jobId immediately; work runs via Cloud Tasks;
-- callers poll GET /api/connectors/jobs/:jobId for completion.

CREATE TABLE connector_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT        NOT NULL,
  connector_id UUID        REFERENCES connectors(id) ON DELETE SET NULL,
  operation    TEXT        NOT NULL,
  input        JSONB       NOT NULL DEFAULT '{}',   -- NEVER stores credentials
  status       TEXT        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  result       JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX connector_jobs_tenant_idx   ON connector_jobs (tenant_id, id);
CREATE INDEX connector_jobs_expires_idx  ON connector_jobs (expires_at);

-- Reuse the set_updated_at() trigger defined in migration 001.
CREATE TRIGGER connector_jobs_updated_at
  BEFORE UPDATE ON connector_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE connector_jobs ENABLE ROW LEVEL SECURITY;

-- Same 2-arg missing_ok form as all other tenant-scoped policies (migration 002).
CREATE POLICY connector_jobs_tenant_isolation ON connector_jobs
  USING     (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Cleanup function (pattern from migration 005). Called by polling scheduler.
CREATE OR REPLACE FUNCTION cleanup_expired_connector_jobs()
RETURNS void AS $$
BEGIN
  DELETE FROM connector_jobs WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
