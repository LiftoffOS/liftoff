// Does this agent already have a structured workflow?
//
// `workflowSteps` is deliberately optional — the hybrid engine runs a
// prose-only agent perfectly well, and a first distill that emits no graph is a
// valid outcome. So "the model omitted workflowSteps" cannot be an error on its
// own the way a missing `instructionsMd` is.
//
// It IS an error when the agent already has one. A redistill that drops the
// graph is not choosing prose-only; it is losing work, and because
// `service.update` treats `workflowSteps: undefined` as "leave unchanged", the
// loss is invisible: the agent keeps executing the OLD graph under the NEW
// instructions, with nothing recording that the two no longer agree.
//
// For example: an agent's responsibilities are edited to post into a new
// channel and saved, which triggers a redistill. The distiller regenerates
// `instructions_md` — it names the new channel — and emits no `workflowSteps`,
// so the graph keeps a step still hardcoding the old channel. The agent goes
// on posting to the wrong channel, the operator has done everything right, and
// no error is raised anywhere.
import { withTenantScope } from '../infrastructure/database';

/** Number of steps the agent's CURRENT graph carries. 0 when the agent is new,
 *  prose-only, or cannot be read — all of which mean "nothing to lose here". */
export async function currentWorkflowStepCount(
  tenantId: string,
  agentId: string,
): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT COALESCE(jsonb_array_length(workflow_steps), 0)::int AS c
         FROM internal_agents
        WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId],
    );
    return Number(res.rows[0]?.c ?? 0);
  });
}

/** Did the model actually emit a graph?
 *
 *  An omitted key, an explicit null, and an empty array all mean the same thing
 *  to `service.update` — nothing to write — so they must mean the same thing
 *  here. Checking only `!toolInput.workflowSteps` would let `[]` through, and an
 *  empty array is the most likely way a model "answers" the retry feedback
 *  without doing the work.
 */
export function rawWorkflowStepsPresent(toolInput: unknown): boolean {
  const v = (toolInput as { workflowSteps?: unknown } | null | undefined)?.workflowSteps;
  return Array.isArray(v) && v.length > 0;
}
