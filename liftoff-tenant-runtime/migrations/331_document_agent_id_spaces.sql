-- Migration 331: make the two agent id spaces self-documenting in the schema.
--
-- Comment-only. No DDL, no data change, no locks of consequence.
--
-- Motivation: `internal_agents` (control plane) and `agents` (runtime) describe
-- the same conceptual thing under disjoint uuids, with the link living in a
-- third table. Without comments, `\d+ agents` and
-- `\d+ internal_agent_runtime_mapping` in psql — exactly where someone
-- debugging would look — say nothing about it. The split is deliberate and
-- correct; it should also be visible.
--
-- See invariant INV-TR-010 (resolve-runtime-agent-id.ts).

BEGIN;

COMMENT ON TABLE internal_agent_runtime_mapping IS
  'THE ONLY link between the two agent id spaces: Platform Backend '
  'internal_agents.id (control plane, what the UI and cross-service payloads '
  'carry) and this runtime''s agents.id (what every runtime-keyed table stores). '
  'The spaces are disjoint by construction — agents.id is a fresh uuidv4 minted '
  'in handleInternalAgentCreated — so an id from one space matches nothing in '
  'the other and queries silently return zero rows. Translate with '
  'resolveRuntimeAgentId / resolveRuntimeAgentIdStrict / resolveInternalAgentId '
  '(src/agent-lifecycle/resolve-runtime-agent-id.ts). See INV-TR-010.';

COMMENT ON COLUMN internal_agent_runtime_mapping.internal_agent_id IS
  'Platform Backend internal_agents.id — control-plane id space. Owned by the '
  'control plane; this runtime never mints one.';

COMMENT ON COLUMN internal_agent_runtime_mapping.agent_id IS
  'This runtime''s agents.id — runtime id space. FK to agents(id).';

COMMENT ON COLUMN agents.id IS
  'Runtime-local agent id (uuidv4, minted here at provisioning). The Platform '
  'Backend addresses this same agent by a DIFFERENT id; join '
  'internal_agent_runtime_mapping to translate. Never compare this to an id '
  'that arrived from the control plane.';

COMMENT ON COLUMN memories.agent_id IS
  'RUNTIME agents.id. Filtering this by a Platform Backend internal_agents.id '
  'returns zero rows with no error (the UI then shows "No learned context yet"). '
  'Translate first (INV-TR-010).';

COMMENT ON COLUMN invocations.agent_id IS
  'RUNTIME agents.id. The cost feeds consumed by the Platform Backend translate '
  'this to internal_agents.id before emitting (see listInvocationsForIngestion); '
  'do not publish this value to the control plane untranslated (INV-TR-010).';

COMMENT ON COLUMN compiled_instructions.agent_id IS
  'RUNTIME agents.id. Translate a Platform Backend id first (INV-TR-010).';

-- Naming trap worth calling out explicitly: this column is named
-- internal_agent_id but holds a RUNTIME id (it carries an FK to agents(id)).
COMMENT ON COLUMN audit_logs.internal_agent_id IS
  'MISNOMER: despite the name this is the RUNTIME agents.id (see the FK to '
  'agents(id)), not the control-plane internal_agents.id. Kept for backwards '
  'compatibility. Translate control-plane ids before filtering (INV-TR-010).';

COMMIT;
