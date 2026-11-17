-- WS-5.4 — per-manifest daily dispatchability probe history + materialized
-- "current health" view for the operator dashboard.
--
-- Keyed by connector_manifests.id (the TR-side analogue of the PB
-- `connectors` instance). The materialized view rolls last-hour probes up to
-- a healthy/degraded/unknown flag so the dashboard renders without a
-- per-request aggregation cost.

CREATE TABLE connector_binding_probes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_manifest_id    uuid NOT NULL REFERENCES connector_manifests(id) ON DELETE CASCADE,
  tenant_id                uuid NOT NULL,
  probed_at                timestamptz NOT NULL DEFAULT NOW(),
  ok                       boolean NOT NULL,
  error                    text,
  latency_ms               integer
);

CREATE INDEX cbp_recent ON connector_binding_probes (connector_manifest_id, probed_at DESC);

-- Materialized view of "current health" for the dashboard. Rolls last-hour
-- probes into healthy/degraded/unknown per manifest.
CREATE MATERIALIZED VIEW connector_binding_health AS
SELECT
  cm.id AS connector_manifest_id,
  cm.tenant_id,
  cm.connector_type,
  cm.alias,
  cm.display_name,
  COUNT(*) FILTER (WHERE p.probed_at > NOW() - INTERVAL '1 hour' AND NOT p.ok) AS recent_failures,
  CASE
    WHEN COUNT(*) FILTER (WHERE p.probed_at > NOW() - INTERVAL '1 hour' AND NOT p.ok) >= 3 THEN 'degraded'
    WHEN COUNT(*) FILTER (WHERE p.probed_at > NOW() - INTERVAL '1 hour') = 0 THEN 'unknown'
    ELSE 'healthy'
  END AS health
FROM connector_manifests cm
LEFT JOIN connector_binding_probes p ON p.connector_manifest_id = cm.id
WHERE cm.enabled = true
GROUP BY cm.id;

CREATE UNIQUE INDEX connector_binding_health_pk ON connector_binding_health (connector_manifest_id);
