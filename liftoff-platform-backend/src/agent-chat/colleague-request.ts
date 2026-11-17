// A team brings a colleague into its own chat.
//
// A person tells their team that a workflow step is wrong, asks it for a
// number only the workspace's records hold, or asks something outside its
// role. The team cannot change its own configuration, cannot see the
// workspace's records, and must not guess. The three platform assistants can:
// the Chief AI Officer changes teams, the Insights Manager answers from the
// workspace's data, Liftoff answers everything else. The team's
// bring_in_colleague tool lands on this rail.
//
// One rule, enforced rather than asked: a change to an agent is the Chief AI
// Officer's to make, whoever asks. So a request to the Chief AI Officer is a
// `design` proposal on the one-open-proposal rail: the Chief AI Officer
// previews it in the team's chat, the person answers there, and a yes applies
// it as the person. A request to the Insights Manager or Liftoff is an answer:
// the colleague runs with no mutating action, no colleague of its own and no
// browser (nobody is present to confirm anything), and its reply is posted
// into the team's chat under its own name. Because an answer needs no yes, an
// unattended run may ask for one too, and gets it back inline.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { enqueueColleagueTask } from './chat-turn-dispatch';
import type { AssistantKind } from './assistant-targets';
import {
  createSuggestion,
  getOpenSuggestion,
  markDecided,
  markOffered,
  type AgentSuggestion,
} from './suggestion-service';

/** What the team is told, and what the classifier reads the person's reply
 *  against. The preview itself is the Chief AI Officer's to write. */
export function designProposalText(change: string): string {
  return (
    `That is a change to how I am built, so it is the Chief AI Officer's to make: ${change} `
    + 'The Chief AI Officer will post here what would change, and it happens only when you agree.'
  );
}

/** Keyed on the change as stated so the same ask twice is one proposal. */
function designDedupKey(change: string): string {
  return `design:${change.trim().toLowerCase().slice(0, 200)}`;
}

export type ColleagueRequestRegistration =
  | { registered: true }
  | { registered: false; reason: 'open_proposal_exists' | 'already_offered' | 'not_recorded' };

/**
 * A change to what the team is, handed to the Chief AI Officer: recorded as an
 * open design proposal on the team, stamped on the thread the person asked in,
 * and previewed by the Chief AI Officer into that thread.
 */
export async function registerDesignChange(params: {
  tenantId: string;
  agentId: string;
  threadId: string;
  change: string;
  area?: string;
}): Promise<ColleagueRequestRegistration> {
  const { tenantId, agentId, threadId, change } = params;
  const suggestion = await createSuggestion({
    tenantId,
    agentId,
    dedupKey: designDedupKey(change),
    source: 'chat',
    proposalText: designProposalText(change),
    routineProse: change,
    provenanceNote: 'You asked for this while we were talking.',
    action: 'change',
    proposalKind: 'design',
    ...(params.area ? { targetLabel: params.area } : {}),
  });
  if (!suggestion) {
    const open = await getOpenSuggestion(tenantId, agentId);
    return { registered: false, reason: open ? 'open_proposal_exists' : 'already_offered' };
  }
  try {
    await markOffered(tenantId, suggestion.id, threadId);
  } catch (err) {
    log.error(
      { tenantId, agentId, suggestionId: suggestion.id, error: (err as Error).message },
      'colleague request: could not stamp the proposal on its thread; releasing it',
    );
    await markDecided(tenantId, suggestion.id, 'cooldown', 0).catch(() => {});
    return { registered: false, reason: 'not_recorded' };
  }
  try {
    await enqueueColleagueTask(
      { tenantId, agentId, threadId, colleague: 'caio', phase: 'preview', request: change, suggestionId: suggestion.id },
      `design-preview:${suggestion.id}`,
    );
  } catch (err) {
    // A proposal the Chief AI Officer will never see must not hold the budget
    // or leave the person waiting for a preview that is not coming.
    log.error(
      { tenantId, agentId, suggestionId: suggestion.id, error: (err as Error).message },
      'colleague request: could not hand the proposal to the Chief AI Officer; releasing it',
    );
    await markDecided(tenantId, suggestion.id, 'cooldown', 0).catch(() => {});
    return { registered: false, reason: 'not_recorded' };
  }
  return { registered: true };
}

/**
 * A question for the Insights Manager or Liftoff, asked in a chat: answered
 * out of turn into that chat under the colleague's name. No proposal row: an
 * answer needs no yes and holds no budget.
 */
export async function registerColleagueQuestion(params: {
  tenantId: string;
  agentId: string;
  threadId: string;
  colleague: Exclude<AssistantKind, 'caio'>;
  request: string;
}): Promise<ColleagueRequestRegistration> {
  const { tenantId, agentId, threadId, colleague, request } = params;
  try {
    await enqueueColleagueTask(
      { tenantId, agentId, threadId, colleague, phase: 'answer', request },
      `colleague-answer:${threadId}:${colleague}:${Date.now()}`,
    );
    return { registered: true };
  } catch (err) {
    log.error(
      { tenantId, agentId, threadId, colleague, error: (err as Error).message },
      'colleague request: could not hand the question over',
    );
    return { registered: false, reason: 'not_recorded' };
  }
}

/** The colleague's thread paired with a team chat, or null before its first ask. */
export async function getPairedColleagueThread(
  tenantId: string,
  threadId: string,
  colleague: AssistantKind,
): Promise<string | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ colleague_thread_id: string }>(
      `SELECT colleague_thread_id FROM agent_chat_colleague_threads
        WHERE tenant_id = $1 AND thread_id = $2 AND colleague = $3`,
      [tenantId, threadId, colleague],
    );
    return res.rows[0]?.colleague_thread_id ?? null;
  });
}

/** The reverse lookup: the team chat a colleague's thread is paired with, so
 *  the source-conversation read can resolve a Chief AI Officer thread that
 *  was brought in from a team's chat. Only a pairing under the caller's
 *  tenant answers. */
export async function getTeamThreadByColleagueThread(
  tenantId: string,
  colleague: AssistantKind,
  colleagueThreadId: string,
): Promise<{ threadId: string } | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ thread_id: string }>(
      `SELECT thread_id FROM agent_chat_colleague_threads
        WHERE tenant_id = $1 AND colleague = $2 AND colleague_thread_id = $3`,
      [tenantId, colleague, colleagueThreadId],
    );
    return res.rows[0] ? { threadId: res.rows[0].thread_id } : null;
  });
}

/** Keep the first pairing: two asks racing must not split the colleague's
 *  side into two threads. Returns the thread that stands. */
export async function pairColleagueThread(
  tenantId: string,
  threadId: string,
  colleague: AssistantKind,
  colleagueThreadId: string,
): Promise<string> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ colleague_thread_id: string }>(
      `INSERT INTO agent_chat_colleague_threads (tenant_id, thread_id, colleague, colleague_thread_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, thread_id, colleague) DO UPDATE SET colleague_thread_id = agent_chat_colleague_threads.colleague_thread_id
       RETURNING colleague_thread_id`,
      [tenantId, threadId, colleague, colleagueThreadId],
    );
    return res.rows[0]?.colleague_thread_id ?? colleagueThreadId;
  });
}

/** Whether a design proposal was opened on this thread: the chat turn reads
 *  it to skip the learning pass, so the same sentence is not also filed as a
 *  technique. */
export async function designChangeJustRegistered(tenantId: string, agentId: string, threadId: string): Promise<boolean> {
  try {
    const open: AgentSuggestion | null = await getOpenSuggestion(tenantId, agentId);
    return !!open && open.proposalKind === 'design' && open.threadId === threadId;
  } catch {
    return false;
  }
}
