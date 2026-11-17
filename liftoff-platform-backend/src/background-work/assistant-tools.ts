// Starting work without waiting for it, for an assistant with nobody to
// hand it to.
//
// An agent can be handed a background objective. The three platform
// assistants could not: they are conversational surfaces with no task queue,
// so anything slow happened inside the turn, and a turn is the person
// waiting. There is exactly one assistant in a thread.
//
// `bring_in_colleague` was never this. It HANDS THE TURN OVER — the
// colleague writes the rest of the reply and the caller gets nothing back. A
// hand-off, not a fan-out.
//
// IT RIDES THE CONTINUATION'S RAILS (migration 550). A continuation is
// already a durable row, a Cloud Task on a queue whose retries wait for a
// busy thread, and a worker that claims it, takes the surface's own turn
// lock and runs the assistant. Every property this needs, including the one
// that matters most: because the work takes the thread's lock like any other
// turn, a busy conversation makes it WAIT rather than land on top of
// somebody mid-sentence. Push delivery that structurally cannot interrupt.
//
// So there is nothing to collect. The answer arrives in the conversation on
// its own, which is why this offers one tool and not two, and why its words
// tell the model not to wait and not to do the job itself.

import type { LLMToolDefinition } from '../llm/types';
import { log } from '../infrastructure/logging';
import { enqueueBackgroundWork, type ContinuationSurface } from '../chat-continuations/store';
import { enqueueContinuationTask } from '../chat-continuations/dispatch';

export const START_BACKGROUND_WORK_TOOL = 'work_on_this_in_the_background';

const BRIEF_CAP = 4_000;

export const startBackgroundWorkTool: LLMToolDefinition = {
  name: START_BACKGROUND_WORK_TOOL,
  description:
    'Set a long job going and carry on talking. Use it when something will take a while and the person is '
    + 'still here: research across many sources, reading a long document, a browser job that spans pages, '
    + 'anything you would otherwise grind through while they wait. It returns at once. '
    + 'You do NOT collect the result and you do not wait for it: when the work is done its answer is posted '
    + 'into this conversation on its own. Tell the person in one line what you have set going, then carry on '
    + 'with whatever else they need. '
    + 'The brief must stand on its own, because whoever picks it up does not see this conversation as you see '
    + 'it now: say what to do, what finished looks like, and the detail from here that matters. '
    + 'Do not use it for something you can simply answer, and do not use it to look busy. '
    + 'If an agent in this workspace does this kind of work, bring that team in instead.',
  input_schema: {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description: 'The whole job, standing on its own: what to do, what finished looks like, and the detail from this conversation that matters.',
      },
    },
    required: ['brief'],
  },
};

export const backgroundWorkTools: LLMToolDefinition[] = [startBackgroundWorkTool];

export function isBackgroundWorkTool(name: string): boolean {
  return name === START_BACKGROUND_WORK_TOOL;
}

export interface BackgroundWorkContext {
  tenantId: string;
  threadId: string;
  surface: ContinuationSurface;
  accountId: string;
  /** The person's message that set this going. The row hangs off it, as a
   *  continuation's does, so the two are counted and read the same way. */
  originMessageId: string;
}

/**
 * Start it, and answer in the words the model will relay.
 *
 * The row first, the task second, exactly as a continuation does it: a row
 * with no task is picked up by nothing and is visible as queued, where a
 * task with no row would run against nothing at all.
 */
export async function runBackgroundWorkTool(
  input: Record<string, unknown>,
  ctx: BackgroundWorkContext,
): Promise<string> {
  const brief = typeof input.brief === 'string' ? input.brief.trim().slice(0, BRIEF_CAP) : '';
  if (!brief) return 'That needs the whole job in words, standing on its own.';
  if (!ctx.originMessageId) {
    // Nothing to hang the row off: a turn with no message of the person's is
    // not one that can set work going on their behalf.
    return 'Background work can only be started from something the person asked for.';
  }
  try {
    const row = await enqueueBackgroundWork({
      tenantId: ctx.tenantId,
      surface: ctx.surface,
      threadId: ctx.threadId,
      accountId: ctx.accountId,
      originMessageId: ctx.originMessageId,
      brief,
    });
    await enqueueContinuationTask(row.id, ctx.tenantId);
    log.info(
      { tenantId: ctx.tenantId, threadId: ctx.threadId, continuationId: row.id, surface: ctx.surface, event: 'background_work_started' },
      'an assistant set a long job going and carried on talking',
    );
    return 'Set going. It runs on its own and posts what it finds into this conversation when it is done, so do '
      + 'not wait for it and do not do the job yourself. Tell the person in one line what you have set going, '
      + 'then carry on with whatever else they need.';
  } catch (err) {
    log.error({ err: (err as Error).message, tenantId: ctx.tenantId }, 'background work could not be set going');
    return 'That could not be set going just now. Tell the person plainly rather than trying again in this turn.';
  }
}
