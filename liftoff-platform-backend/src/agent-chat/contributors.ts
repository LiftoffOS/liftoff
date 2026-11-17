// Who else had a hand in a team's reply, resolved once for every writer.
//
// The runtime says which teammates a run handed work to as RUNTIME agent ids
// (its agents.id — a different id space from internal_agents, INV-TR-010). A
// reply is stored with the teammates' internal_agents ids and the names the
// person sees, so every path that writes a team's speech to a transcript
// translates the same way: the SSE consumer on the live stream, the settle
// callback a closed tab falls back to, the continuation a HITL approval
// resumes and the reply a self-woken run delivers. One resolver, in a module
// none of those import each other through, so the four cannot drift and none
// of them has to import the chat service to attribute a row.

import { withTenantScope } from '../infrastructure/database';
import { getRuntimeToInternalMap } from '../internal-agents/runtime-agent-id-map';
import type { Contributor } from '../chat-attachments';

/** The teams behind a list of runtime agent ids, as the contributors a reply
 *  is attributed to: each one's internal_agents id and the name the person
 *  sees for it.
 *
 *  One query for the whole list, order preserved as given (first-brought-in
 *  order, which is the order the person watched the hand-overs arrive),
 *  duplicates and ids that no longer resolve dropped: a team deleted between
 *  the hand-over and the write cannot be named, and a chip with no name is
 *  worse than none. Best-effort throughout: an attribution that cannot be
 *  resolved must not fail the turn it describes. */
export async function resolveContributors(
  tenantId: string,
  runtimeAgentIds: readonly string[],
): Promise<Contributor[]> {
  if (runtimeAgentIds.length === 0) return [];
  try {
    const idMap = await getRuntimeToInternalMap(tenantId);
    const internalIds = [...new Set(
      runtimeAgentIds
        .map((runtimeId) => idMap.get(runtimeId))
        .filter((id): id is string => typeof id === 'string'),
    )];
    if (internalIds.length === 0) return [];
    // internal_agents carries FORCE RLS; an unscoped pool read throws 42704
    // (INV-PB-001), so the read is tenant-scoped like every other read of
    // this table.
    const rows = await withTenantScope(tenantId, (client) =>
      client.query<{ id: string; role: string }>(
        'SELECT id, role FROM internal_agents WHERE id = ANY($1::uuid[]) AND tenant_id = $2',
        [internalIds, tenantId],
      ),
    );
    const roleById = new Map(rows.rows.map((row) => [row.id, row.role]));
    return internalIds
      .filter((id) => roleById.has(id))
      .map((id) => ({ id, label: roleById.get(id)! }));
  } catch {
    return [];
  }
}
