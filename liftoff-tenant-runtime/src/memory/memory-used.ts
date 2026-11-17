// Usefulness per injected memory, at the run's end.
//
// Usefulness moved on three substring heuristics that cannot tell a helpful
// memory from a bystander, and on failure every injected memory was
// punished for a run it may not have shaped. This asks, per injected
// memory, whether the run's actions or output depended on it: one `ask` of
// the `memory_used` set with one Noul per memory, input only, one request
// per completed run with injected memories. The caller applies +1 on
// success and −1 on failure to the memories above USED_T only, and falls
// back to the heuristics (success) or every injected memory (failure) when
// this returns null: the kill, or no answer.

import { logger } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import {
  asEntry,
  memoryUsedSet,
  MEMORY_USED_CONTENT_MAX_CHARS,
  MEMORY_USED_OUTCOME_MAX_CHARS,
  MEMORY_USED_TRAIL_MAX_CHARS,
} from '../typesafe/questions';
import { isMemoryUsedEnabled } from '../typesafe/flags';

export interface MemoryUsedInput {
  memories: Array<{ id: string; content: string }>;
  run: {
    objective: string;
    /** The tool names and arguments the run dispatched, in order. */
    toolTrail: unknown;
    outcomeSummary: string;
  };
  tenantId: string;
  /** The RUNTIME agent id. */
  agentId?: string;
  invocationId?: string;
}

/** The whole call's budget. */
export const MEMORY_USED_DEADLINE_MS = 30_000;

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** The ids of the memories the run depended on, or null for today's path. */
export async function usedMemories(input: MemoryUsedInput): Promise<string[] | null> {
  if (!isMemoryUsedEnabled()) return null;
  if (input.memories.length === 0) return [];
  const set = memoryUsedSet(input.memories.length);
  let trail: string;
  try {
    trail = typeof input.run.toolTrail === 'string' ? input.run.toolTrail : JSON.stringify(input.run.toolTrail ?? []);
  } catch {
    trail = '';
  }
  const state = asEntry({
    memories: input.memories.map((m, i) => ({ memory: i, id: m.id, content: cut(m.content, MEMORY_USED_CONTENT_MAX_CHARS) })),
    run: {
      objective: cut(input.run.objective, MEMORY_USED_OUTCOME_MAX_CHARS),
      toolTrail: cut(trail, MEMORY_USED_TRAIL_MAX_CHARS),
      outcomeSummary: cut(input.run.outcomeSummary, MEMORY_USED_OUTCOME_MAX_CHARS),
    },
  });
  const answer = await ask(set, state, {
    deadlineMs: MEMORY_USED_DEADLINE_MS,
    tenantId: input.tenantId,
    ...(input.agentId ? { runtimeAgentId: input.agentId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
  });
  if (!answer) return null;
  const t = set.thresholds.USED_T as number;
  const answers = answer.answers as Record<string, { noul?: number } | undefined>;
  const used = input.memories
    .filter((_, i) => (answers[`used_${i}`]?.noul ?? 0) >= t)
    .map((m) => m.id);
  logger.info({
    metric: 'memory_used.verdict',
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    invocation_id: input.invocationId,
    call_id: answer.callId,
    injected: input.memories.length,
    used: used.length,
  }, 'memory used: verdict');
  return used;
}
