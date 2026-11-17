-- WS-8.2 Layer 3 — RLS policy must exclude quarantined rows from every read.

DROP POLICY IF EXISTS memories_tenant_isolation ON memories;
CREATE POLICY memories_tenant_isolation ON memories
  FOR SELECT
  USING (
    tenant_id = current_setting('liftoff.tenant_id')::uuid
    AND dlp_quarantine_at IS NULL
  );
