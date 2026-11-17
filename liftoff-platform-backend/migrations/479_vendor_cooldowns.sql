-- Migration 479: vendor_cooldowns — a credential that just failed at account
-- level is remembered, briefly, so the next capability call does not spend a
-- vendor call and a model turn rediscovering it.
--
-- A platform-funded vendor (tikhub, strale, nasdaq, gloria through the
-- connector registry; the store actors through the platform Apify account)
-- answers a dead account one endpoint at a time: a 401 on a revoked key or a
-- 402 on an exhausted balance looks, to the caller, like one function failing
-- once. Nothing remembered that the CREDENTIAL had failed, so a search kept
-- offering that vendor's other endpoints and a run kept trying them.
--
-- One row per credential. `credential_ref` is the key the executor actually
-- dispatched on: `internal:<type>` for the platform key (shared by every
-- workspace, so its failure is true for every workspace at that moment) or
-- `connector:<id>` for a workspace's own connected connector (that connector
-- only). Two connectors of one type in one workspace are two rows. The key is
-- NOT NULL, so a repeat park is an upsert on the primary key and no partial
-- unique index is needed for the nullable tenant column.
--
-- `tenant_id` is attribution for an operator reading the table, never a
-- boundary: the platform row has none, and the reader keys by credential.
-- Platform-scoped like capability_usage_evidence (migration 431): no RLS.
-- The reader is src/capability-discovery/vendor-gate.ts; the writer is
-- src/capability-discovery/vendor-execution.ts; the operator read is
-- GET /api/admin/vendor-cooldowns.
--
-- `reason` names the two signals that park: an authentication failure the
-- wire classified as such, or an explicit payment-required response. Nothing
-- else writes here — an outage, a rate limit, a forbidden resource and a bad
-- argument are per call, not per credential. `expires_at` is set by the
-- writer (ten minutes; src/capability-discovery/config.ts); an expired row is
-- ignored on read and overwritten on the next park, never swept.

CREATE TABLE IF NOT EXISTS vendor_cooldowns (
  credential_ref VARCHAR(128) PRIMARY KEY,
  connector_type VARCHAR(64) NOT NULL,
  tenant_id      UUID,
  reason         VARCHAR(16) NOT NULL CHECK (reason IN ('auth', 'payment')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_cooldowns_expires
  ON vendor_cooldowns (expires_at);
