// POST /api/internal/chat-turns/colleague — one phase of a colleague a team
// brought into its chat (colleague-request.ts), plus the inline answer for a
// team running unattended.
//
// preview: the Chief AI Officer reads the team and previews the change on a
// thread paired with the team's chat; its reply is posted into that chat under
// its own name, so the person answers where they asked.
// apply: the person's yes (or no) is carried to the same thread; the Chief AI
// Officer applies the change as the person, with the handle its preview
// minted, and its reply is posted the same way.
// answer: the Insights Manager or Liftoff answers a question, in answer mode
// (no mutating action, no colleague of its own, no browser: nobody is present
// to confirm anything), and the reply is posted the same way.
//
// Runs as a Cloud Task on the chat-turns queue, like the redistill accept: a
// colleague's turn is tens of seconds and the process that took the person's
// message is not guaranteed to outlive its own response. Every outcome is
// said truthfully in the thread; a turn that fails posts a plain line and
// releases what it held.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members/service';
import { internalAgentService } from '../internal-agents/service';
import { resolveAccountIdForTenant } from '../cost-attribution/repository';
import type { ActorOrigin } from '../workspace-actions/actor';
import { assistantByKind, type AssistantKind } from './assistant-targets';
import { COLLEAGUE_MESSAGE_TYPE } from './colleague-message-type';
import type { Contributor } from '../chat-attachments';
import { AssistantUnreachableError, createAssistantThread, runAssistantTurn } from './assistant-turn';
import * as chatRepo from './chat-repository';
import { getPairedColleagueThread, pairColleagueThread } from './colleague-request';
import { forwardedContextForModel } from '../liftoff/forwarded-context';
import { pushOutOfTurnMessage } from './out-of-turn-delivery';
import { markDecided, releaseClaim } from './suggestion-service';
import { teamDisplayName } from '../workspace-actions/teams';
import { verifyWorkerOidc } from './worker-oidc';

export const colleagueWorkerRouter = Router();

// The row type lives beside the readers that need it; re-exported so the
// worker's own callers keep their import.
export { COLLEAGUE_MESSAGE_TYPE } from './colleague-message-type';

const taskSchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  threadId: z.string().uuid(),
  colleague: z.enum(['liftoff', 'caio', 'insights']),
  phase: z.enum(['preview', 'apply', 'answer']),
  request: z.string().min(1),
  suggestionId: z.string().uuid().optional(),
  decision: z.enum(['accept', 'decline']).optional(),
  amendment: z.string().optional(),
});

const UNIQUE_VIOLATION = '23505';
const LAST_RETRY_COUNT = 3;
const accountService = new AccountService();

function speakerOf(kind: AssistantKind): string {
  return assistantByKind(kind)?.name ?? 'Liftoff';
}

/** The colleague as the row's contributor: the same id vocabulary the
 *  mention roster and Liftoff's `author` use ('liftoff', 'caio', 'insights'),
 *  and the name the person sees, stored beside the reply like every other
 *  contributor so a later rename never relabels it. */
function contributorFor(kind: AssistantKind): Contributor {
  return { id: kind, label: speakerOf(kind) };
}

/** Post one message to the team's thread exactly once across retries, and
 *  push it where the thread lives. A team's chat has one voice by default,
 *  and this is not it, so the row is attributed to the colleague through
 *  `contributors`, the field every surface draws a colleague's chip from.
 *  The text itself is stored verbatim; the speaker is prefixed only where
 *  the reader has no chip to look at, which is the Slack or Teams push. */
async function postOnce(params: {
  tenantId: string;
  threadId: string;
  agentId: string;
  colleague: AssistantKind;
  text: string;
  externalRef: string;
}): Promise<void> {
  const speaker = speakerOf(params.colleague);
  try {
    await chatRepo.appendMessage(
      params.tenantId, params.threadId, 'assistant', params.text, params.agentId,
      undefined, undefined, undefined, COLLEAGUE_MESSAGE_TYPE, undefined, undefined, undefined, params.externalRef,
      undefined, [contributorFor(params.colleague)],
    );
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return;
    throw err;
  }
  // agentId null: the text names its speaker, and the Slack push would
  // otherwise prefix the team's name over the colleague's.
  await pushOutOfTurnMessage({
    tenantId: params.tenantId, threadId: params.threadId, agentId: null, text: `${speaker}: ${params.text}`,
  });
}

/** Where the person spoke, for attribution of what the colleague does on
 *  their behalf. The dashboard is the default and carries no origin. */
function originFor(channel: string): ActorOrigin | undefined {
  if (channel === 'slack' || channel === 'teams' || channel === 'mcp') {
    return { via: channel, client: 'team-chat', credentialId: '' };
  }
  return undefined;
}

// What the colleague is sent, in two parts that never meet in a row.
//
// The USER ROW is what a person can read: the Chief AI Officer's paired thread
// is listed in their Plan history, and the Insights Manager's and Liftoff's in
// theirs. So it carries the sentence and nothing else: no team id, no tool
// name, no instruction. The BRIEF carries the id the colleague's tools need
// and how to handle the turn; it is read by the model this turn and never
// persisted (liftoff/forwarded-context.ts). The team is the forwarder, so the
// one status row the thread keeps names it.

interface ColleagueTurnText {
  /** Persisted as the person's turn on the colleague's thread. */
  userRow: string;
  /** For the colleague's model only. Null when the row says everything. */
  brief: string | null;
}

function previewRequest(personName: string, teamName: string, teamId: string, change: string): ColleagueTurnText {
  return {
    userRow: `${personName} asked the agent "${teamName}", in its own chat, for this change to the agent itself: "${change}".`,
    brief:
      `The agent's id is ${teamId}. Read it with team_get, draft the smallest update that carries the change, and call `
      + 'team_update without a confirmation handle so you get the preview. Reply for that chat: what would change, in their '
      + 'terms, quoting the current text where it matters, ending with one question, whether to apply it. Do not apply it. '
      + "The agent's conversation, with its browser trail, is readable with source_conversation__read.",
  };
}

function applyRequest(decision: 'accept' | 'decline', amendment: string | undefined, change: string): ColleagueTurnText {
  if (decision === 'decline') {
    return {
      userRow: 'No, leave the agent as it is; do not apply the change.',
      brief: `The change was: "${change}". Reply in one sentence for that chat.`,
    };
  }
  return {
    userRow: amendment ? `Yes, apply it, with this amendment: ${amendment}.` : 'Yes, apply it.',
    brief: amendment
      ? 'Call team_update with the confirmation handle from your preview; preview again first if the amendment changes the text. Reply for that chat with what changed and its new version.'
      : 'Call team_update with the confirmation handle from your preview. Reply for that chat with what changed and its new version.',
  };
}

function answerRequest(personName: string, teamName: string, request: string): ColleagueTurnText {
  return {
    userRow: `The agent "${teamName}" is working for ${personName} and asked you this on their behalf: "${request}".`,
    brief:
      'Answer it for that team\'s chat, in plain words, with the facts you can read. You cannot change anything from here; '
      + 'if the ask needs a change, say that the Chief AI Officer makes it.',
  };
}

/** The brief as the colleague's model reads it, framed the way every
 *  hand-over's is, with the team named as the forwarder. */
function briefFromTeam(text: ColleagueTurnText, teamName: string): string | null {
  return text.brief ? forwardedContextForModel(text.userRow, text.brief, teamName) : null;
}

const PREVIEW_FAILED = 'I could not look at this change just now. Ask the agent again in a little while, or bring it to me directly.';
const APPLY_FAILED = 'I could not apply this change just now. Nothing was changed. Ask the agent again in a little while, or bring it to me directly.';
const ANSWER_FAILED = 'I could not answer that just now. Ask the agent again in a little while, or ask me directly.';

/** The person a colleague acts as, for a team chat: the person in the thread. */
async function personInThread(tenantId: string, accountId: string) {
  const [membership, account] = await Promise.all([
    tenantMembersService.getMembership(tenantId, accountId),
    accountService.getById(accountId),
  ]);
  if (!membership || !account) return null;
  const name = `${account.firstName ?? ''} ${account.lastName ?? ''}`.trim() || account.email || 'A member of the workspace';
  return { accountId, role: membership.role, name };
}

/** The person a colleague acts as for a team running unattended: the
 *  workspace's own account, the same identity an assistant's spend is booked
 *  to when no person is in the turn. An answer is read as that account and
 *  attributed to it. */
async function personForTeam(tenantId: string) {
  const owner = await resolveAccountIdForTenant(tenantId);
  return owner ? personInThread(tenantId, owner) : null;
}

/**
 * Answer a question inline, for a team with no chat and no person present.
 * The colleague runs in answer mode on a fresh thread of its own; the reply
 * is the tool result. Never throws: a failure is a truthful `answered: false`.
 */
export async function answerInline(params: {
  tenantId: string;
  agentId: string;
  colleague: Exclude<AssistantKind, 'caio'>;
  request: string;
}): Promise<{ answered: true; reply: string } | { answered: false; reason: string }> {
  const { tenantId, agentId, colleague, request } = params;
  try {
    const agent = await internalAgentService.getById(agentId, tenantId);
    if (!agent) return { answered: false, reason: 'not_registerable' };
    const person = await personForTeam(tenantId);
    if (!person) return { answered: false, reason: 'no_person' };
    const threadId = await createAssistantThread(colleague, { tenantId, accountId: person.accountId, role: person.role });
    const teamName = teamDisplayName(agent);
    const text = answerRequest(person.name, teamName, request);
    const outcome = await runAssistantTurn(colleague, {
      tenantId,
      threadId,
      userMessage: text.userRow,
      forwardedContext: briefFromTeam(text, teamName),
      forwardedBy: { id: agentId, label: teamName },
      accountId: person.accountId,
      displayName: person.name,
      role: person.role,
      toolMode: 'answer',
    });
    if (outcome.terminal !== 'completed' || !outcome.replyContent) {
      return { answered: false, reason: outcome.errorCode ?? 'no_reply' };
    }
    log.info({ tenantId, agentId, colleague, threadId }, 'colleague answered a team inline');
    return { answered: true, reply: outcome.replyContent };
  } catch (err) {
    log.warn({ tenantId, agentId, colleague, error: (err as Error).message }, 'colleague inline answer failed');
    return { answered: false, reason: err instanceof AssistantUnreachableError ? 'unavailable' : 'failed' };
  }
}

colleagueWorkerRouter.post('/colleague', async (req: Request, res: Response) => {
  if (!(await verifyWorkerOidc(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const raw = typeof req.body === 'string' ? JSON.parse(Buffer.from(req.body, 'base64').toString()) : req.body;
  const parsed = taskSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues }, 'colleague task: malformed task dropped');
    return res.status(200).json({ dropped: true });
  }
  const task = parsed.data;
  const retryCount = Number(req.header('X-CloudTasks-TaskRetryCount') ?? '0');
  const { tenantId, agentId, threadId, colleague, phase, suggestionId } = task;
  const failureText = phase === 'preview' ? PREVIEW_FAILED : phase === 'apply' ? APPLY_FAILED : ANSWER_FAILED;

  const failed = async (err: unknown): Promise<Response> => {
    log.error({ tenantId, agentId, suggestionId: suggestionId ?? null, colleague, phase, error: (err as Error).message }, 'colleague task: phase failed');
    if (retryCount >= LAST_RETRY_COUNT) {
      await postOnce({ tenantId, threadId, agentId, colleague, text: failureText, externalRef: `colleague:${colleague}:${threadId}:${suggestionId ?? Date.now()}:${phase}:failed` }).catch(() => {});
      if (suggestionId) {
        if (phase === 'preview') await markDecided(tenantId, suggestionId, 'cooldown', 0).catch(() => {});
        else await releaseClaim(tenantId, suggestionId).catch(() => {});
      }
      return res.status(200).json({ ok: false, gaveUp: true });
    }
    return res.status(500).json({ error: 'retry' });
  };

  try {
    const [thread, agent] = await Promise.all([
      chatRepo.getThread(threadId, tenantId),
      internalAgentService.getById(agentId, tenantId),
    ]);
    if (!thread || !agent) {
      log.error({ tenantId, agentId, threadId }, 'colleague task: thread or team gone; dropped');
      if (suggestionId) await markDecided(tenantId, suggestionId, 'cooldown', 0).catch(() => {});
      return res.status(200).json({ dropped: true });
    }
    const person = await personInThread(tenantId, thread.accountId);
    if (!person) {
      // The person who asked is no longer a member: nothing can be done as them.
      await postOnce({ tenantId, threadId, agentId, colleague, text: failureText, externalRef: `colleague:${colleague}:${threadId}:${suggestionId ?? Date.now()}:${phase}:nomember` }).catch(() => {});
      if (suggestionId) await markDecided(tenantId, suggestionId, 'cooldown', 0).catch(() => {});
      return res.status(200).json({ ok: false });
    }
    const caller = { tenantId, accountId: person.accountId, role: person.role };

    let colleagueThreadId = await getPairedColleagueThread(tenantId, threadId, colleague);
    if (!colleagueThreadId) {
      const created = await createAssistantThread(colleague, caller);
      colleagueThreadId = await pairColleagueThread(tenantId, threadId, colleague, created);
    }

    const teamName = teamDisplayName(agent);
    const text = phase === 'preview'
      ? previewRequest(person.name, teamName, agentId, task.request)
      : phase === 'apply'
        ? applyRequest(task.decision ?? 'accept', task.amendment, task.request)
        : answerRequest(person.name, teamName, task.request);

    const origin = originFor(thread.channel);
    const outcome = await runAssistantTurn(colleague, {
      tenantId,
      threadId: colleagueThreadId,
      userMessage: text.userRow,
      forwardedContext: briefFromTeam(text, teamName),
      forwardedBy: { id: agentId, label: teamName },
      accountId: person.accountId,
      displayName: person.name,
      role: person.role,
      ...(origin ? { origin } : {}),
      ...(phase === 'answer' ? { toolMode: 'answer' as const } : {}),
    });
    if (outcome.terminal !== 'completed' || !outcome.replyContent) {
      return failed(new Error(outcome.errorCode ?? 'no reply'));
    }

    await postOnce({ tenantId, threadId, agentId, colleague, text: outcome.replyContent, externalRef: `colleague:${colleague}:${threadId}:${suggestionId ?? task.request.slice(0, 40)}:${phase}` });
    if (phase === 'apply' && suggestionId) {
      await markDecided(tenantId, suggestionId, task.decision === 'decline' ? 'dismissed' : 'accepted');
    }
    log.info({ tenantId, agentId, suggestionId: suggestionId ?? null, colleague, phase, colleagueThreadId, decision: task.decision ?? null }, 'colleague task: phase posted');
    return res.status(200).json({ ok: true });
  } catch (err) {
    return failed(err);
  }
});
