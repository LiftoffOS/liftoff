// Pinned knowledge markers in an agent's prose.
//
// Save-time helper shared by the dashboard route and the workspace action:
// parses [[knowledge:id:title]] markers from the agent's prose fields,
// validates each pin's source connector is bound to the agent, and returns the
// validated id list.

import * as knowledgeRepo from '../knowledge/repository';

// RFC 4122 UUID regex. Marker IDs are persisted as UUID[] in
// internal_agents.pinned_knowledge_ids and queried via id = ANY($::uuid[]);
// anything that isn't a valid UUID would make Postgres throw
// "invalid input syntax for type uuid" and break the save. The marker regex
// itself accepts any non-colon non-bracket sequence so operators can type
// garbage; this filter is the safety net.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Parses [[knowledge:id:title]] markers from the agent's prose fields, validates
// each pin's source connector is bound to the agent, and returns the validated
// ID list. Silently filters orphan pins (missing item OR unbound connector OR
// malformed UUID); the React UI surfaces them as broken chips so the operator
// stays aware. Save remains non-blocking — broken references don't prevent
// saving the agent.
// Exported for unit testing.
export async function parseAndFilterPinnedKnowledge(
  tenantId: string,
  boundConnectorIds: Set<string>,
  ...textFields: (string | null | undefined)[]
): Promise<string[]> {
  const combined = textFields.filter(Boolean).join('\n')
  const matches = [...combined.matchAll(/\[\[knowledge:([^:\]]+):[^\]]+\]\]/g)]
  if (!matches.length) return []

  // Drop non-UUID ids before they reach findByIds — see UUID_RE comment.
  const uniqueIds = [...new Set(matches.map(m => m[1]))].filter(id => UUID_RE.test(id))
  if (!uniqueIds.length) return []

  const items = await knowledgeRepo.findByIds(tenantId, uniqueIds)
  const found = new Map(items.map(i => [i.id, i]))

  return uniqueIds.filter(id => {
    const item = found.get(id)
    if (!item) return false                       // item deleted from knowledge_items
    if (item.connectorId === null) return true    // manual URL — always allowed
    return boundConnectorIds.has(item.connectorId) // connector must be bound
  })
}

