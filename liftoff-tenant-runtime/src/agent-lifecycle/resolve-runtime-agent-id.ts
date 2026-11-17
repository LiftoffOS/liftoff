// Translate between the two agent id spaces. See INV-TR-010 in docs/invariants.md
// and docs/runbooks/resolve-agent-id.md.
//
// The Platform Backend addresses agents by their control-plane
// internal_agents.id in URL params and cross-service payloads. The tenant
// runtime, however, stores agents.id / memories.agent_id /
// compiled_instructions.agent_id as the runtime's own uuidv4 agent_id, minted
// in handleInternalAgentCreated. The two id-spaces are linked only through the
// internal_agent_runtime_mapping table. Any code that filters or writes a
// runtime-keyed table using an id that arrived from PB MUST translate first,
// or it silently reads/writes nothing (see the "No learned context yet"
// memory-list regression this helper was extracted to fix).
//
// Three entry points, and the choice between them matters:
//
//   resolveRuntimeAgentId       — lenient. Falls back to the input id when no
//                                 mapping row exists. Correct for READS: an
//                                 agent that is not provisioned yet simply has
//                                 nothing to return, and the caller sees an
//                                 empty result that fills in once provisioning
//                                 completes.
//   resolveRuntimeAgentIdStrict — no fallback, returns null. Required for
//                                 WRITES to runtime-keyed tables that have no
//                                 foreign key to agents(id). An FK-protected
//                                 table rejects a wrong-space id loudly; an
//                                 FK-less one persists it forever, invisible to
//                                 every correctly-translated reader even after
//                                 the mapping appears.
//   resolveInternalAgentId      — reverse direction, runtime -> PB. Never falls
//                                 back (a wrong id must not be queried against
//                                 PB).
//
// Every miss emits a registered structured event so the silent-empty class of
// bug is greppable and alertable rather than invisible. Pass `caller` to say
// which code path asked.

import { getPoolForService } from '../infrastructure/database';
import { scrubLogger } from '../observability/scrub-logger';

/** What the mapping says about one id.
 *
 *  `already` means the caller handed us a RUNTIME id, which is not a miss and
 *  must not be reported as one. Several callers legitimately hold one — the
 *  agent-execution loop passes the id it is running under — and translating it
 *  found no `internal_agent_id` row, warned, and fell back to the input. The
 *  fallback is the right answer there BY LUCK, and the warning fired on every
 *  web-tool call of every run.
 *
 *  That is the cost: a genuine miss, where a control-plane id has no mapping
 *  row and the fallback really does query the wrong id space, looked exactly
 *  like the benign case. Dozens of the benign one per run buried it. */
type MappingAnswer =
  | { kind: 'translated'; runtimeAgentId: string }
  | { kind: 'already' }
  | { kind: 'missing' };

async function lookupRuntimeAgentId(
  tenantId: string,
  agentId: string,
): Promise<MappingAnswer> {
  const pool = getPoolForService('scheduled-execution');
  // Both columns in ONE statement: a second round trip to ask "was it already a
  // runtime id" would double the cost of the hot path this sits on.
  const result = await pool.query<{ agent_id: string; by_internal: boolean }>(
    `SELECT agent_id, (internal_agent_id = $1) AS by_internal
       FROM internal_agent_runtime_mapping
      WHERE tenant_id = $2 AND (internal_agent_id = $1 OR agent_id = $1)
      ORDER BY by_internal DESC
      LIMIT 1`,
    [agentId, tenantId],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'missing' };
  // `by_internal` wins the ordering above, so an id that is somehow both is
  // translated rather than passed through — the translation is the meaningful
  // reading of an internal id.
  return row.by_internal
    ? { kind: 'translated', runtimeAgentId: row.agent_id }
    : { kind: 'already' };
}

/**
 * PB internal_agents.id -> TR agents.id, falling back to the input id when the
 * agent has no mapping row yet. Read paths only — see the note above.
 */
export async function resolveRuntimeAgentId(
  tenantId: string,
  internalAgentId: string,
  caller?: string,
): Promise<string> {
  const answer = await lookupRuntimeAgentId(tenantId, internalAgentId);
  // Already a runtime id: idempotent, and silent. Not a miss.
  if (answer.kind === 'already') return internalAgentId;
  if (answer.kind === 'missing') {
    scrubLogger.warn({
      event: 'agent_id_mapping_miss',
      tenantId,
      internalAgentId,
      caller: caller ?? 'unknown',
      fellBack: true,
    });
    return internalAgentId;
  }
  return answer.runtimeAgentId;
}

/**
 * PB internal_agents.id -> TR agents.id with NO identity fallback.
 *
 * Use for writes to runtime-keyed tables that lack an FK to agents(id) —
 * chat_feedback_queue is the canonical case. Returning null lets the caller
 * refuse the write (409 agent_not_provisioned) instead of persisting a
 * control-plane id into a runtime-keyed column, where it would be unreachable
 * from every correctly-translated reader.
 */
export async function resolveRuntimeAgentIdStrict(
  tenantId: string,
  internalAgentId: string,
  caller?: string,
): Promise<string | null> {
  const answer = await lookupRuntimeAgentId(tenantId, internalAgentId);
  // Already a runtime id. The strict variant exists to stop a CONTROL-PLANE id
  // reaching a runtime-keyed column; an id that is already runtime is exactly
  // what the caller wants to write, so refusing it would refuse correct writes.
  if (answer.kind === 'already') return internalAgentId;
  if (answer.kind === 'missing') {
    scrubLogger.warn({
      event: 'agent_id_mapping_miss',
      tenantId,
      internalAgentId,
      caller: caller ?? 'unknown',
      fellBack: false,
    });
    return null;
  }
  const runtimeAgentId = answer.runtimeAgentId;
  return runtimeAgentId;
}

/**
 * Reverse mapping: TR runtime agents.id -> PB internal_agents.id.
 * Plan v13 Change 4: NO identity fallback — an unmapped runtime id returns
 * null so callers skip (a wrong id must never be queried against PB).
 */
export async function resolveInternalAgentId(
  tenantId: string,
  runtimeAgentId: string,
  caller?: string,
): Promise<string | null> {
  const pool = getPoolForService('scheduled-execution');
  const result = await pool.query<{ internal_agent_id: string }>(
    `SELECT internal_agent_id FROM internal_agent_runtime_mapping
     WHERE agent_id = $1 AND tenant_id = $2`,
    [runtimeAgentId, tenantId],
  );
  const internalAgentId = result.rows[0]?.internal_agent_id ?? null;
  if (!internalAgentId) {
    scrubLogger.warn({
      event: 'agent_id_reverse_mapping_miss',
      tenantId,
      runtimeAgentId,
      caller: caller ?? 'unknown',
    });
  }
  return internalAgentId;
}
