-- A.2 — Deep MCP binding probe per-transport routing.
--
-- The probe code in src/connectors/binding-probe.ts now routes per connector
-- transport (vendor-hosted MCP / sidecar / composio_managed / REST direct).
-- Recording WHICH strategy ran lets the dashboard show what was actually
-- tested — e.g. "Notion last probed via vendor_mcp_tools_list, OK; Gmail
-- last probed via composio_credential_refresh, FAILED auth".
--
-- Backward-compatible: the column is nullable so pre-A.2 rows survive with
-- probe_kind=NULL. The materialized connector_binding_health view is rebuilt
-- so dashboards can filter by the last-known probe_kind per manifest. The
-- new index supports `WHERE probe_kind = '<kind>'` queries that the
-- dashboard runs to slice "degraded composio bindings" vs "degraded vendor
-- MCP bindings" — without it those queries sequential-scan a table that
-- grows daily.

ALTER TABLE connector_binding_probes
  ADD COLUMN IF NOT EXISTS probe_kind TEXT;

COMMENT ON COLUMN connector_binding_probes.probe_kind IS
  'Which deep-probe strategy ran. One of: registry_only, vendor_mcp_tools_list, sidecar_tools_list, composio_credential_refresh, rest_auth_test. NULL for rows recorded before this column existed.';

-- B6: index for dashboard slicing by probe_kind. Partial NOT NULL filter
-- keeps the index small (~95% of rows post-rollout will be one of the deep
-- kinds; the registry_only and NULL rows don't need indexed lookup).
CREATE INDEX IF NOT EXISTS cbp_probe_kind
  ON connector_binding_probes (probe_kind, probed_at DESC)
  WHERE probe_kind IS NOT NULL;

-- MG1: rebuild connector_binding_health to surface the last probe_kind per
-- manifest. The dashboard now shows "Notion · vendor_mcp_tools_list · OK"
-- instead of just "Notion · OK", which makes degradation triage one click
-- instead of three.
DROP MATERIALIZED VIEW IF EXISTS connector_binding_health;

CREATE MATERIALIZED VIEW connector_binding_health AS
WITH latest AS (
  SELECT DISTINCT ON (p.connector_manifest_id)
    p.connector_manifest_id,
    p.probe_kind     AS last_probe_kind,
    p.probed_at      AS last_probed_at,
    p.ok             AS last_ok
  FROM connector_binding_probes p
  ORDER BY p.connector_manifest_id, p.probed_at DESC
)
SELECT
  cm.id AS connector_manifest_id,
  cm.tenant_id,
  cm.connector_type,
  cm.alias,
  cm.display_name,
  l.last_probe_kind,
  l.last_probed_at,
  l.last_ok,
  COUNT(*) FILTER (WHERE p.probed_at > NOW() - INTERVAL '1 hour' AND NOT p.ok) AS recent_failures,
  CASE
    WHEN COUNT(*) FILTER (WHERE p.probed_at > NOW() - INTERVAL '1 hour' AND NOT p.ok) >= 3 THEN 'degraded'
    WHEN COUNT(*) FILTER (WHERE p.probed_at > NOW() - INTERVAL '1 hour') = 0 THEN 'unknown'
    ELSE 'healthy'
  END AS health
FROM connector_manifests cm
LEFT JOIN connector_binding_probes p ON p.connector_manifest_id = cm.id
LEFT JOIN latest l ON l.connector_manifest_id = cm.id
WHERE cm.enabled = true
GROUP BY cm.id, l.last_probe_kind, l.last_probed_at, l.last_ok;

CREATE UNIQUE INDEX connector_binding_health_pk ON connector_binding_health (connector_manifest_id);
CREATE INDEX connector_binding_health_kind ON connector_binding_health (last_probe_kind, health);
