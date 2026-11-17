// Chat-turn Cloud Tasks dispatch (Slack + Teams).
//
// Enqueues the durable chat-turn worker task into the SAME-project queue
// `chat-turns-{env}` (dispatchDeadline 600s, maxAttempts 4, minBackoff 5s,
// maxBackoff 60s, maxConcurrentDispatches 20; the queue SA has run.invoker on
// platform-backend itself). Task name = sha256 of the surface event id —
// Cloud Tasks is at-least-once and named tasks dedup redelivery of the same
// inbound event.
//
// Why a queue at all: live services run with cpu-throttling:'true' and
// minScale 0, so post-response compute is neither CPU-guaranteed nor safe from
// instance reclaim — the worker executes inside its OWN request and therefore
// always has CPU and a pinned instance.

import { createHash } from 'crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import { log } from '../infrastructure/logging';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import type { SlackChatTask } from './slack-adapter/slack-chat-worker';
import type { TeamsChatTask } from './teams-adapter/teams-chat-worker';

const client = new CloudTasksClient();

const projectId = process.env.GCP_PROJECT_ID || '';
const location = process.env.GCP_LOCATION || 'us-west1';

// The Slack payload deliberately EXCLUDES the bot token: a queued task body
// should carry no live credential. The worker re-resolves the token from the
// workspace install at execution time.
export type ChatTurnTask =
  | { surface: 'slack'; task: Omit<SlackChatTask, 'botToken'> }
  | { surface: 'teams'; task: TeamsChatTask };

/** gRPC ALREADY_EXISTS — a named task for this event is already queued
 *  (redelivery of the same inbound event). Benign. */
const GRPC_ALREADY_EXISTS = 6;

export function isDuplicateTaskError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === GRPC_ALREADY_EXISTS;
}

export async function enqueueChatTurnTask(dedupeId: string, payload: ChatTurnTask): Promise<void> {
  const queuePath = client.queuePath(
    projectId,
    location,
    `chat-turns-${process.env.ENVIRONMENT || 'dev'}`,
  );
  const invokerSa = process.env.CHAT_TURNS_INVOKER_SA || '';

  const [response] = await client.createTask({
    parent: queuePath,
    task: {
      name: `${queuePath}/tasks/${createHash('sha256').update(dedupeId).digest('hex').slice(0, 40)}`,
      // The worker turn is bounded by the TR stream's 5-min abort + surface
      // finalization overhead; 600s also stays under the service's 900s
      // request timeout.
      dispatchDeadline: { seconds: 600 },
      httpRequest: {
        httpMethod: 'POST' as const,
        url: `${getBackendUrl()}/api/internal/chat-turns/execute`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        ...(invokerSa
          ? { oidcToken: { serviceAccountEmail: invokerSa, audience: getBackendUrl() } }
          : {}),
      },
    },
  });

  log.info(
    { surface: payload.surface, taskName: response.name },
    'chat turn enqueued',
  );
}

/** What the redistill worker needs: who to redistill, and — when a person is
 *  waiting in a chat thread — which proposal this settles, where the
 *  confirmation belongs, and the routine line for its wording (carried here so
 *  the worker does not re-read a row it already trusts). The CAIO update path
 *  sends only the first two: its user is told in-conversation that the change
 *  takes minutes and lands on the Teams page, so there is nothing to post. */
export interface RedistillAcceptTask {
  tenantId: string;
  agentId: string;
  suggestionId?: string;
  threadId?: string;
  routineProse?: string;
  /** What the accept did to the prose (migration 429); shapes the
   *  confirmation's wording. Absent means start, for wire compatibility. */
  action?: 'start' | 'change' | 'stop';
  targetLabel?: string;
  /** The exact guidance line a stop removed. The worker parses the stopped
   *  cadence from it, so the redistill can be told what must NOT appear —
   *  the line itself is gone from the guidance and states it more faithfully
   *  than the label the person used. */
  replacesProse?: string;
}

/** One phase of a colleague brought into a team's chat. The Chief AI Officer
 *  previews a change (`preview`) and applies or declines it after the person
 *  answered (`apply`); the Insights Manager and Liftoff answer a question
 *  (`answer`). */
export interface ColleagueTask {
  tenantId: string;
  agentId: string;
  threadId: string;
  colleague: 'liftoff' | 'caio' | 'insights';
  phase: 'preview' | 'apply' | 'answer';
  /** The change or the question in the person's terms; carried on every
   *  phase so the apply turn can restate it when the colleague's thread has
   *  to be rebuilt. */
  request: string;
  /** The design proposal this belongs to; preview and apply only. */
  suggestionId?: string;
  /** Apply phase only. */
  decision?: 'accept' | 'decline';
  amendment?: string;
}

/**
 * Enqueue one phase of a colleague's work on the same queue and under the same
 * reasoning as the redistill accept: a colleague's turn is tens of seconds
 * and the process that took the person's message cannot be trusted to outlive
 * its own response. The dedupe id names the phase and the ask, so a
 * redelivered enqueue cannot run the preview twice.
 */
export async function enqueueColleagueTask(task: ColleagueTask, dedupeId: string): Promise<void> {
  const queuePath = client.queuePath(projectId, location, `chat-turns-${process.env.ENVIRONMENT || 'dev'}`);
  const invokerSa = process.env.CHAT_TURNS_INVOKER_SA || '';
  const dedupe = createHash('sha256').update(dedupeId).digest('hex').slice(0, 40);
  const [response] = await client.createTask({
    parent: queuePath,
    task: {
      name: `${queuePath}/tasks/${dedupe}`,
      dispatchDeadline: { seconds: 600 },
      httpRequest: {
        httpMethod: 'POST' as const,
        url: `${getBackendUrl()}/api/internal/chat-turns/colleague`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(task)).toString('base64'),
        ...(invokerSa ? { oidcToken: { serviceAccountEmail: invokerSa, audience: getBackendUrl() } } : {}),
      },
    },
  });
  log.info(
    { suggestionId: task.suggestionId ?? null, agentId: task.agentId, colleague: task.colleague, phase: task.phase, taskName: response.name },
    'colleague task enqueued',
  );
}

/**
 * Enqueue the background half of a suggestion accept: the redistill that turns
 * the just-appended guidance line into an actual trigger, plus the
 * confirmation message once it lands.
 *
 * Same queue and the same reasoning as the chat turns above: post-response
 * compute on this service is neither CPU-guaranteed nor safe from reclaim, so
 * the redistill has to run inside its own request. The caller names the task
 * through dedupeId: the accept path keys on the suggestion id (a redelivered
 * enqueue cannot queue the work twice, and a re-accept of a re-opened proposal
 * is separated from the tombstone by the 30-day cooldown), while the CAIO
 * update path keys on a fresh uuid, because two rapid prose edits each deserve
 * a redistill that has seen the later text.
 */
export async function enqueueRedistillAcceptTask(
  task: RedistillAcceptTask,
  dedupeId: string,
): Promise<void> {
  const queuePath = client.queuePath(
    projectId,
    location,
    `chat-turns-${process.env.ENVIRONMENT || 'dev'}`,
  );
  const invokerSa = process.env.CHAT_TURNS_INVOKER_SA || '';

  const dedupe = createHash('sha256')
    .update(dedupeId)
    .digest('hex')
    .slice(0, 40);

  const [response] = await client.createTask({
    parent: queuePath,
    task: {
      name: `${queuePath}/tasks/${dedupe}`,
      // A single redistill measured minutes, not seconds; 600s is the same
      // ceiling the chat-turn worker runs under and stays inside the service's
      // request timeout.
      dispatchDeadline: { seconds: 600 },
      httpRequest: {
        httpMethod: 'POST' as const,
        url: `${getBackendUrl()}/api/internal/chat-turns/redistill-accept`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(task)).toString('base64'),
        ...(invokerSa
          ? { oidcToken: { serviceAccountEmail: invokerSa, audience: getBackendUrl() } }
          : {}),
      },
    },
  });

  log.info(
    { suggestionId: task.suggestionId, agentId: task.agentId, taskName: response.name },
    'redistill-accept enqueued',
  );
}
