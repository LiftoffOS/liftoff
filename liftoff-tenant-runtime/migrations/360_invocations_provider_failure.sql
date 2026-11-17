-- 360: invocations — record what the PROVIDER said, not what we inferred.
--
-- failure_class (migration 308, provider split in 355) is derived by
-- classifyFailure, which is ~90 lines of regex over error_message. That function
-- is careful — its status matcher requires digit boundaries AND a context marker
-- so "processed 401 records" is not read as an auth failure — and it is still
-- reading prose, and prose matching misfires.
--
-- These four columns record the STRUCTURED facts the providers already send and
-- we were discarding, so the derived class can be checked against its evidence
-- instead of taken on trust:
--
--   provider_failure_kind  our taxonomy (auth / quota / rate_limit / overloaded /
--                          server_error / network / invalid_request / refusal /
--                          safety / malformed_response / unknown)
--   provider_error_type    the provider's OWN identifier, verbatim:
--                          'overloaded_error', 'insufficient_quota', 'SAFETY'
--   provider_status        the HTTP status, as a number rather than a substring
--   provider_request_id    the provider's request id
--
-- provider_request_id alone justifies the set: when a provider asks for a
-- request id on a support ticket, this is the only place to find it — for any
-- failure, on any engine.
--
-- No backfill. Old rows stay NULL, which reads correctly as "this run predates
-- structured capture" rather than as "the provider sent nothing".
--
-- The partial index is deliberate: the overwhelming majority of invocations
-- succeed and carry NULL here, so indexing them would be storage spent on rows
-- no query wants. Tenant-first because every operator question about failures is
-- scoped to one tenant.

ALTER TABLE invocations
  ADD COLUMN IF NOT EXISTS provider_failure_kind text,
  ADD COLUMN IF NOT EXISTS provider_error_type   text,
  ADD COLUMN IF NOT EXISTS provider_status       integer,
  ADD COLUMN IF NOT EXISTS provider_request_id   text;

CREATE INDEX IF NOT EXISTS idx_invocations_provider_failure
  ON invocations (tenant_id, provider_failure_kind)
  WHERE provider_failure_kind IS NOT NULL;

COMMENT ON COLUMN invocations.provider_failure_kind IS
  'What the provider said went wrong, in our taxonomy (agent-execution/adapter/provider-failure.ts): auth, quota, rate_limit, overloaded, server_error, network, invalid_request, refusal, safety, malformed_response, unknown. Read from the thrown error''s structured fields, NOT inferred from error_message. NULL on a successful run and on any run that predates structured capture.';
COMMENT ON COLUMN invocations.provider_error_type IS
  'The provider''s own error identifier, verbatim and unmapped: "overloaded_error", "insufficient_quota", "SAFETY". Kept alongside the mapped kind so a provider introducing a new type is visible as itself rather than collapsing into "unknown".';
COMMENT ON COLUMN invocations.provider_status IS
  'HTTP status from the provider, as a number. Distinct from any status appearing inside error_message, which may belong to a tool gateway or a connector''s upstream rather than to the model provider.';
COMMENT ON COLUMN invocations.provider_request_id IS
  'The provider''s request id for the failing call — the one field a vendor asks for on a support ticket. Extracted from whichever of six places the SDK put it (requestID / request_id / $metadata.requestId / request-id / x-request-id headers). NULL before structured capture existed.';
