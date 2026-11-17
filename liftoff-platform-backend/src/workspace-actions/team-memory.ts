// A team's memories and skills, for the assistants: the runtime's memories
// (list, delete, edit) and the skills listing the settings page reads — the
// platform column merged with the runtime projection. Skill edits themselves
// go through applyTeamUpdate's skill verbs, so provenance moves the way the
// page moves it (INV-8).

import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { internalAgentService } from '../internal-agents/service';
import { log } from '../infrastructure/logging';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export interface TeamMemory {
  id: string;
  content: string;
  source: string;
  createdAt: string;
  usefulnessScore?: number;
  lastUsedAt?: string;
}

export async function listMemories(
  actor: Actor,
  agentId: string,
  opts: { limit?: number; cursor?: string; search?: string } = {},
): Promise<{ memories: TeamMemory[]; nextCursor: string | null } | { refused: 'not_found'; message: string }> {
  const agent = await internalAgentService.getById(agentId, actor.tenantId);
  if (!agent) return { refused: 'not_found', message: 'agent not found' };
  const result = await tenantRuntimeClient.listAgentMemories(actor.tenantId, agentId, opts);
  return { memories: result.memories, nextCursor: result.nextCursor };
}

export async function deleteMemory(actor: Actor, agentId: string, memoryId: string): Promise<{ deleted: true } | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'teams:update');
  const agent = await internalAgentService.getById(agentId, actor.tenantId);
  if (!agent) return { refused: 'not_found', message: 'agent not found' };
  try {
    await tenantRuntimeClient.deleteAgentMemory(actor.tenantId, agentId, memoryId);
  } catch (err) {
    if (/HTTP 404/.test((err as Error).message)) return { refused: 'not_found', message: 'No memory with that id.' };
    throw err;
  }
  writeAudit(actor, 'internal_agent.memory_deleted', { internalAgentId: agentId, memoryId });
  return { deleted: true };
}

export async function updateMemory(
  actor: Actor,
  agentId: string,
  memoryId: string,
  content: string,
): Promise<{ memory: { id: string; content: string; updatedAt: string } } | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'teams:update');
  const agent = await internalAgentService.getById(agentId, actor.tenantId);
  if (!agent) return { refused: 'not_found', message: 'agent not found' };
  try {
    const memory = await tenantRuntimeClient.updateAgentMemory(actor.tenantId, agentId, memoryId, content);
    writeAudit(actor, 'internal_agent.memory_updated', { internalAgentId: agentId, memoryId });
    return { memory };
  } catch (err) {
    if (/HTTP 404/.test((err as Error).message)) return { refused: 'not_found', message: 'No memory with that id.' };
    throw err;
  }
}

export interface TeamSkillView {
  id?: string;
  name: string;
  description: string;
  instruction: string;
  tags: string[];
  provenance: 'distilled' | 'learned' | 'operator';
  protected: boolean;
  archived: boolean;
}

/** The skills listing behind GET /:id/skills: the platform column is
 *  authoritative (it alone holds provenance, protection and archived skills);
 *  the runtime is consulted only for the id of a skill the column has not
 *  caught up on, and anything the runtime runs that the column has not
 *  recorded yet is shown as learned. */
export async function listSkills(actor: Actor, agentId: string): Promise<{ skills: TeamSkillView[] } | { refused: 'not_found'; message: string }> {
  const agent = await internalAgentService.getById(agentId, actor.tenantId);
  if (!agent) return { refused: 'not_found', message: 'agent not found' };

  const stored = agent.skills ?? [];
  let runtimeSkills: Array<{ id: string; name: string; description: string; instruction: string; tags: string[] }> = [];
  try {
    const runtimeResult = await tenantRuntimeClient.getAgentSkills(actor.tenantId, agentId);
    runtimeSkills = runtimeResult.skills ?? [];
  } catch (err) {
    log.warn({ internalAgentId: agentId, tenantId: actor.tenantId, error: (err as Error).message }, 'skills: runtime lookup failed, returning the stored set');
  }
  const runtimeIdByName = new Map(runtimeSkills.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const storedNames = new Set(stored.map((s) => s.name.trim().toLowerCase()));

  const skills: TeamSkillView[] = [
    ...stored.map((s) => ({
      id: s.id ?? runtimeIdByName.get(s.name.trim().toLowerCase()),
      name: s.name,
      description: s.description,
      instruction: s.instruction,
      tags: s.tags ?? [],
      provenance: s.provenance ?? 'distilled',
      protected: s.protected ?? false,
      archived: s.archived ?? false,
    })),
    ...runtimeSkills
      .filter((s) => !storedNames.has(s.name.trim().toLowerCase()))
      .map((s) => ({ ...s, provenance: 'learned' as const, protected: false, archived: false })),
  ];
  return { skills };
}
