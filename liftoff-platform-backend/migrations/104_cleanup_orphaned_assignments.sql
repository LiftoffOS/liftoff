-- Soft-delete person_agent_assignments whose referenced agent has been
-- soft-deleted.  During the initial Claude Code proxy key launch, the
-- fire-and-forget assignment cleanup on key revocation could fail silently,
-- leaving orphaned rows that surface as "Works with null" in the UI.
--
-- This covers all three agent tables (internal_agents, external_agents,
-- claude_code_proxy_keys) so any other orphans are caught too.

UPDATE person_agent_assignments pa
SET    deleted_at = NOW()
WHERE  pa.deleted_at IS NULL
  AND  NOT EXISTS (
         SELECT 1 FROM internal_agents ia
         WHERE  ia.id = pa.agent_id
           AND  pa.agent_origin = 'internal'
           AND  ia.deleted_at IS NULL
       )
  AND  NOT EXISTS (
         SELECT 1 FROM external_agents ea
         WHERE  ea.id = pa.agent_id
           AND  pa.agent_origin = 'external'
           AND  ea.deleted_at IS NULL
       )
  AND  NOT EXISTS (
         SELECT 1 FROM claude_code_proxy_keys ckp
         WHERE  ckp.id = pa.agent_id
           AND  pa.agent_origin = 'external'
           AND  ckp.deleted_at IS NULL
       );
