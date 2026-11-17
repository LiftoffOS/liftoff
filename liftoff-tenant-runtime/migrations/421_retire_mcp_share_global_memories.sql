-- 421: remove the global-layer memories written through liftoff_share_context
--
-- The control plane's MCP server no longer offers liftoff_share_context or
-- liftoff_read_context (dashboard-parity decision): the global
-- memory layer is not exposed to a person or to a connected tool in either
-- direction, so the notes coding tools wrote into it retire with the tools.
-- Left in place they would keep steering every AI team whose scope reads the
-- global layer, from a source no surface can show and no person can remove.
--
-- A note is identified through its provenance, because memories carries no
-- trigger column: the save recorded a 'system_event' node with ref_id
-- 'mcp-share:<token id>' and a 'produced' edge to the memory's own node
-- (src/memory/provenance-service.ts). The provenance graph rows stay: they
-- are the historical record that the notes existed and were removed.
--
-- memories has RLS enabled but not forced (079's deliberate deferral), so
-- the owner-run migration deletes without a policy escape.

DELETE FROM memories m
USING provenance_nodes mn, provenance_edges pe, provenance_nodes sn
WHERE m.layer = 'global'
  AND mn.node_type = 'memory'
  AND mn.ref_id = m.id::text
  AND mn.tenant_id = m.tenant_id
  AND pe.to_node_id = mn.id
  AND pe.edge_type = 'produced'
  AND sn.id = pe.from_node_id
  AND sn.node_type = 'system_event'
  AND sn.ref_id LIKE 'mcp-share:%';
