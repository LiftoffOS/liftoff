-- Migration 330: close the FK-less strand hole on chat_feedback_queue.agent_id
--
-- chat_feedback_queue.agent_id holds a RUNTIME agents.id, but the column had no
-- foreign key. The tool-proxy feedback route resolved that id through
-- resolveRuntimeAgentId, which falls back to the *input* (control-plane) id when
-- an agent has no internal_agent_runtime_mapping row yet. A miss therefore
-- persisted a control-plane id into a runtime-keyed column: no error, no
-- constraint violation, and permanently invisible to the chat-feedback-extractor
-- and every other correctly-translated reader — even after the mapping appeared.
--
-- Code side (same change set): that route now uses resolveRuntimeAgentIdStrict
-- and returns 409 agent_not_provisioned instead of guessing. This migration
-- repairs any rows the old behaviour already wrote and makes the class of bug
-- structurally impossible.
--
-- See invariant INV-TR-010 (resolve-runtime-agent-id.ts).

BEGIN;

-- 1. Repair rows whose agent_id is a control-plane id that we can translate.
--    Scoped by tenant so a uuid collision across tenants cannot mis-map.
UPDATE chat_feedback_queue c
   SET agent_id = m.agent_id
  FROM internal_agent_runtime_mapping m
 WHERE c.agent_id  = m.internal_agent_id
   AND c.tenant_id = m.tenant_id;

-- 2. Drop rows that resolve to neither id space. These are unreachable by
--    construction: the extractor keys off agents.id, so a row pointing at no
--    agent can never be processed or surfaced. Deleting them is what makes the
--    FK below validatable.
DELETE FROM chat_feedback_queue c
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = c.agent_id);

-- 3. Add the FK. NOT VALID first so the ALTER takes only a brief lock and does
--    not scan the table while holding it — the pattern this repo uses on
--    RLS-FORCED tables (migrations 321/322/326), where a validating ADD
--    CONSTRAINT has failed on Cloud SQL before.
ALTER TABLE chat_feedback_queue
  ADD CONSTRAINT fk_chat_feedback_queue_agent
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  NOT VALID;

-- 4. Validate separately. Takes only a SHARE UPDATE EXCLUSIVE lock, so writes
--    continue during the scan. Steps 1-2 guarantee this succeeds.
ALTER TABLE chat_feedback_queue
  VALIDATE CONSTRAINT fk_chat_feedback_queue_agent;

COMMENT ON COLUMN chat_feedback_queue.agent_id IS
  'RUNTIME agents.id, never the control-plane internal_agents.id. Translate a '
  'Platform Backend id with resolveRuntimeAgentIdStrict() before inserting (INV-TR-010).';

COMMIT;
