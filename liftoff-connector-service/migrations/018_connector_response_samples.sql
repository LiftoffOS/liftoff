-- First-real-response capture: the only real vendor payloads we ever see (we have no test
-- accounts for these HRIS providers). The runtime records ONE redacted sample per
-- (connector_type, function_name) for native-HRIS READ functions — see
-- src/observability/response-capture.ts — and scripts/pull-response-samples.ts turns those into
-- committed fixtures. Cross-tenant + PII-redacted before write, so no RLS/tenant column.
CREATE TABLE IF NOT EXISTS connector_response_samples (
  connector_type TEXT        NOT NULL,
  function_name  TEXT        NOT NULL,
  sample         JSONB       NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_type, function_name)   -- one sample per action, first-write-wins
);
GRANT SELECT, INSERT ON connector_response_samples TO connector_admin;
