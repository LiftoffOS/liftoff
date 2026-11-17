// Admission and kind at the agent's own save (memory_save, note_save).
//
// The Learned Context list's quality was decided by three model generations
// nobody checked (the save decision, the kind, the facet), a classification
// that was never set, and a heuristic. Every column and vocabulary a better
// answer fills already exists; this fills them. One `ask` of the
// `memory_save` set after redaction and the dedup refusal and before the
// insert, add-only against noise:
//
//   admit = task_state / already_in_instructions  → refused, with a
//           model-visible reason in the dedup refusal's form
//   kind / facet / classification                 → the tag or column set
//           from a confident answer; unclear keeps the model's tag
//   relation_to_neighbours = supersedes            → the neighbour retired
//           through supersedeMemory with the new row as successor
//   relation_to_neighbours = contradicts           → both kept, the new row
//           tagged contradicts:<neighbour id>
//
// Never on a person's correction, a run's error record, or a declared graph
// step's save: those rows are records, not the model's judgment. `null` from
// the client, or the kill, is today's save.

import { logger } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import { asEntry, memorySaveSet, MEMORY_NEIGHBOUR_MAX_CHARS } from '../typesafe/questions';
import { isMemoryAdmitEnabled } from '../typesafe/flags';
import { boundedContract, type HitlContract } from '../hitl-enforcement/contract-check';
import { MEMORY_KINDS, USER_MODEL_FACETS, type MemoryKind, type UserModelFacet } from './curation';
import type { ContentClassification } from './types';

export interface MemoryNeighbour {
  id: string;
  content: string;
}

export interface MemoryAdmitInput {
  content: string;
  layer: string;
  requestedTags: string[];
  aboutPerson?: { accountId: string; facet: string };
  contract?: HitlContract;
  /** The top 3 of the recent-similar query, by cosine. */
  neighbours: MemoryNeighbour[];
  tenantId: string;
  /** The RUNTIME agent id. */
  agentId?: string;
  invocationId?: string;
}

export type AdmitRefusal = 'task_state' | 'already_in_instructions';

export interface MemoryAdmitVerdict {
  refuse?: { reason: AdmitRefusal; message: string; p: number };
  kind?: MemoryKind;
  /** A confident facet; `none` on a user_model kind means no facet. */
  facet?: UserModelFacet | 'none';
  classification?: ContentClassification;
  /** Neighbour ids the new row supersedes. */
  supersedes: string[];
  /** Neighbour ids the new row contradicts. */
  contradicts: string[];
}

/** The whole call's budget. */
export const MEMORY_ADMIT_DEADLINE_MS = 30_000;

/** The model-visible reasons, in the dedup refusal's form. */
export const REFUSAL_MESSAGES: Readonly<Record<AdmitRefusal, string>> = {
  task_state: 'not saved: this is the state of the current task. Memory is for what outlives this run; the run already holds where it is up to.',
  already_in_instructions: 'not saved: this is already in your instructions. Memory is for what your instructions do not say.',
};

type Head = { choice?: string; probabilities?: Record<string, number> } | undefined;
const confident = (head: Head, choice: string, t: number): boolean =>
  head?.choice === choice && (head.probabilities?.[choice] ?? 0) >= t;

export async function admitMemory(input: MemoryAdmitInput): Promise<MemoryAdmitVerdict | null> {
  if (!isMemoryAdmitEnabled()) return null;
  const neighbours = input.neighbours.slice(0, 3);
  const set = memorySaveSet(MEMORY_KINDS, USER_MODEL_FACETS, neighbours.length);
  const state = asEntry({
    content: input.content,
    layer: input.layer,
    requestedTags: input.requestedTags,
    ...(input.aboutPerson ? { aboutPerson: input.aboutPerson } : {}),
    contract: input.contract ? boundedContract(input.contract) : null,
    neighbours: neighbours.map((n, i) => ({ neighbour: i, id: n.id, content: n.content.slice(0, MEMORY_NEIGHBOUR_MAX_CHARS) })),
  });
  const answer = await ask(set, state, {
    deadlineMs: MEMORY_ADMIT_DEADLINE_MS,
    tenantId: input.tenantId,
    ...(input.agentId ? { runtimeAgentId: input.agentId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
  });
  if (!answer) return null;
  const answers = answer.answers as Record<string, Head>;
  const t = set.thresholds as Record<string, number>;
  const verdict: MemoryAdmitVerdict = { supersedes: [], contradicts: [] };

  const admit = answers.admit;
  for (const reason of ['task_state', 'already_in_instructions'] as const) {
    if (confident(admit, reason, t.ADMIT_REFUSE_T)) {
      verdict.refuse = { reason, message: REFUSAL_MESSAGES[reason], p: admit?.probabilities?.[reason] ?? 0 };
    }
  }

  const kind = answers.kind;
  if (kind?.choice && (MEMORY_KINDS as readonly string[]).includes(kind.choice) && (kind.probabilities?.[kind.choice] ?? 0) >= t.KIND_T) {
    verdict.kind = kind.choice as MemoryKind;
  }
  // Read only when the kind is user_model or a person was named.
  if (verdict.kind === 'user_model' || input.aboutPerson) {
    const facet = answers.facet;
    const choice = facet?.choice;
    if (choice && (facet?.probabilities?.[choice] ?? 0) >= t.KIND_T) {
      if (choice === 'none') verdict.facet = 'none';
      else if ((USER_MODEL_FACETS as readonly string[]).includes(choice)) verdict.facet = choice as UserModelFacet;
    }
  }
  const classification = answers.classification;
  if (classification?.choice && classification.choice !== 'unclear' && (classification.probabilities?.[classification.choice] ?? 0) >= t.CLASS_T) {
    if (classification.choice === 'pii' || classification.choice === 'sensitive' || classification.choice === 'internal') {
      verdict.classification = classification.choice;
    }
  }
  neighbours.forEach((n, i) => {
    const relation = answers[`relation_${i}`];
    if (confident(relation, 'supersedes', t.SUPERSEDE_T)) verdict.supersedes.push(n.id);
    else if (relation?.choice === 'contradicts') verdict.contradicts.push(n.id);
  });

  logger.info({
    metric: 'memory_admit.verdict',
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    invocation_id: input.invocationId,
    call_id: answer.callId,
    refused: verdict.refuse?.reason ?? null,
    kind: verdict.kind ?? null,
    facet: verdict.facet ?? null,
    classification: verdict.classification ?? null,
    supersedes: verdict.supersedes.length,
    contradicts: verdict.contradicts.length,
  }, 'memory admit: verdict');
  return verdict;
}
