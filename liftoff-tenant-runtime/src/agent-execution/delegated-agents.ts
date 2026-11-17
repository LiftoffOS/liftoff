// Who a run handed work to, as the durable record says.
//
// Every delegation that actually starts writes a delegation_active row keyed
// by the parent invocation (migration 291), after the capacity, depth and
// cycle gates and after any human gate on the call. That makes the table the
// one honest answer to "which teammates had a hand in this reply":
//
//   - A delegate_to_agent call the model emitted but a HITL gate refused, or
//     that never cleared a gate before the turn paused, has no row. The
//     model's tool_use block fires `tool_call_started` before any gate runs,
//     so a list built from the calls it EMITTED would attribute a reply to a
//     teammate that never ran.
//   - A resumed run (after an approval, or after a self-wake) continues under
//     the same invocation id, so the continuation it posts is attributed to
//     every teammate the whole run brought in, whichever side of the pause
//     they ran on. The chat handler's in-memory tool-call list does not exist
//     on those paths at all.
//
// Read once at each point a run's speech is written to a transcript, and sent
// to the control plane as runtime agent ids: the control plane owns the
// display names and resolves them itself, so the two never drift.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** Runtime agent ids of the teammates `parentInvocationId` delegated to, unique
 *  and in the order they were first brought in. Best-effort: attribution that
 *  cannot be read must not fail the turn it describes, so a read error is
 *  logged and reads as nobody. */
export async function listDelegatedAgentIds(
  tenantId: string,
  parentInvocationId: string,
): Promise<string[]> {
  try {
    const pool = getPoolForService('scheduled-execution');
    const result = await pool.query<{ agent_id: string }>(
      `SELECT agent_id
         FROM delegation_active
        WHERE parent_invocation_id = $1 AND tenant_id = $2
        ORDER BY started_at ASC, task_index ASC`,
      [parentInvocationId, tenantId],
    );
    return [...new Set(result.rows.map((row) => row.agent_id))];
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, parentInvocationId },
      'listDelegatedAgentIds: could not read delegation_active; the reply is attributed to nobody',
    );
    return [];
  }
}
