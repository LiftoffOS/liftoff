-- 251 — Backfill connector_manifests for connectors whose original
-- credentials.stored event handler crashed between the connectors INSERT
-- and the connector_manifests INSERT.
--
-- Root cause: src/events/subscriber.ts handleCredentialsStored did four
-- sequential INSERTs without a wrapping transaction. Any failure on the
-- connector_manifests query (transient DB error, deadlock, etc.) committed
-- only the prior INSERTs into `connectors` and `connector_credentials` and
-- left `connector_manifests` + `action_allowlists` missing. Pub/Sub
-- doesn't replay acked-or-already-attempted messages, so the partial
-- state persists forever.
--
-- Symptom: an active `connectors` row with no `connector_manifests` row,
-- so the tool gateway rejects calls with "Connector '<type>' is not in
-- instruction's allowed connectors".
--
-- The companion code fix wraps handleCredentialsStored in a transaction
-- so partial state can never be produced again. This migration recovers
-- any state already left partial — Pub/Sub will not redeliver those
-- messages.
--
-- Idempotent: ON CONFLICT DO NOTHING for both the manifest INSERT and
-- the action_allowlists INSERT — safe to re-run.

-- Backfill missing connector_manifests rows.
-- Mirror the auto-provision logic from subscriber.ts handleCredentialsStored:
--   - manifest.id     = connector.id (the same uuid as connectors.id)
--   - alias           = type with underscores replaced by hyphens
--   - display_name    = type with underscores -> spaces, title-cased
--   - enabled         = true
INSERT INTO connector_manifests (id, tenant_id, connector_type, alias, display_name, enabled)
SELECT
  c.id,
  c.tenant_id,
  c.type,
  REPLACE(c.type, '_', '-'),
  INITCAP(REPLACE(c.type, '_', ' ')),
  true
FROM connectors c
WHERE c.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM connector_manifests m
    WHERE m.tenant_id = c.tenant_id
      AND m.connector_type = c.type
  )
ON CONFLICT (tenant_id, alias) DO NOTHING;

-- Backfill matching action_allowlists rows. Same source-of-truth: every
-- active connector should be allowed by default; per-agent restrictions
-- happen via instruction.allowedConnectors, not via this table.
INSERT INTO action_allowlists (tenant_id, connector, action_type, enabled)
SELECT
  c.tenant_id,
  REPLACE(c.type, '_', '-'),
  '*',
  true
FROM connectors c
WHERE c.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM action_allowlists a
    WHERE a.tenant_id = c.tenant_id
      AND a.connector = REPLACE(c.type, '_', '-')
  )
ON CONFLICT DO NOTHING;
