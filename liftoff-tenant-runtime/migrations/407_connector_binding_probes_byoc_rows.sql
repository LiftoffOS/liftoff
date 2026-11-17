-- 407: connector_binding_probes takes a row for a customer-hosted MCP server.
--
-- A probe row is keyed on the binding's connector id, and that id is the same
-- whether the binding is a connector manifest or a customer-hosted MCP server
-- (both are connector-service connector ids). Only manifests have a row in
-- connector_manifests, so the foreign key on connector_manifest_id refuses
-- every probe of a customer-hosted server. The daily sweep records those
-- probes after the manifest loop, so the refusal ended the run before the
-- health view behind it was refreshed.
ALTER TABLE connector_binding_probes
  DROP CONSTRAINT IF EXISTS connector_binding_probes_connector_manifest_id_fkey;

COMMENT ON COLUMN connector_binding_probes.connector_manifest_id IS
  'The probed binding''s connector id: a connector_manifests.id, or the connector id of a customer-hosted MCP server, which has no manifest row.';

-- The foreign key cascaded a manifest's deletion to its probe rows; the same
-- tidy-up now runs from a trigger, so deleting a manifest still takes its
-- probe history with it.
CREATE OR REPLACE FUNCTION connector_binding_probes_drop_for_manifest()
RETURNS trigger AS $$
BEGIN
  DELETE FROM connector_binding_probes WHERE connector_manifest_id = OLD.id;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connector_binding_probes_drop_for_manifest ON connector_manifests;
CREATE TRIGGER connector_binding_probes_drop_for_manifest
  AFTER DELETE ON connector_manifests
  FOR EACH ROW EXECUTE FUNCTION connector_binding_probes_drop_for_manifest();
