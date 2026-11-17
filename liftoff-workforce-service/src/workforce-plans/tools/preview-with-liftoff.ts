// preview_with_liftoff Tool
//
// The inverse edge of the deliverable-first loop. source_conversation__read
// serves the person who did the work with Liftoff FIRST and then arrived
// here; this tool serves the person who arrived here COLD and would rather
// see the deliverable once than answer an interview about it. It asks
// platform-backend to create a Liftoff conversation seeded with the task,
// PAIRED to this thread, so the existing source_conversation__read return
// trip absorbs whatever happens over there with no new machinery.
//
// Platform-backend owns the pairing and is idempotent on this thread: a
// second call answers with the conversation that already exists rather than
// creating another, because two preview conversations would split the
// person's work in two. The model is told when that happened so it reuses
// the one conversation instead of apologising for a failure.
//
// Auth: X-Service-Auth with WORKFORCE_SERVICE_TOKEN — same pattern as
// source_conversation__read. Import paths use .js extensions (ESM).

import { log } from '../../infrastructure/logging.js';
import { loadConfig } from '../../infrastructure/config.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface PreviewOutput {
  ok: boolean;
  message: string;
}

export const previewWithLiftoffTool: WorkforcePlanTool = {
  definition: {
    name: 'preview_with_liftoff',
    description:
      'Create the one Liftoff conversation for this thread where the person can do the task '
      + 'once with Liftoff and see the real deliverable before anything is built. Provide the '
      + 'task in plain words, as a note to Liftoff the person will read too, and the name this '
      + 'surface shows for you so the note carries your attribution. Call it at most once per '
      + 'conversation: a repeat call returns the conversation that already exists, and the '
      + 'person should continue there rather than start again. When they return, read what '
      + 'happened with source_conversation__read.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The task, in plain words, written as the opening note of the Liftoff '
            + 'conversation. The person and Liftoff both read it, so include what the '
            + 'finished result should look like.',
        },
        colleagueLabel: {
          type: 'string',
          description: 'The name this surface shows for you, used as the note\'s attribution.',
        },
      },
      required: ['task', 'colleagueLabel'],
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<PreviewOutput> {
    if (!ctx.threadId) {
      return {
        ok: false,
        message: 'A preview conversation can only be created inside a conversation.',
      };
    }

    const task = typeof rawInput['task'] === 'string' ? rawInput['task'].trim() : '';
    if (!task) {
      return { ok: false, message: 'A task, in plain words, is required.' };
    }
    const colleagueLabel =
      typeof rawInput['colleagueLabel'] === 'string' && rawInput['colleagueLabel'].trim()
        ? rawInput['colleagueLabel'].trim()
        : 'Chief AI Officer';

    const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
    const secret = loadConfig().WORKFORCE_SERVICE_TOKEN;

    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/internal/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Auth': secret,
        },
        body: JSON.stringify({
          tenantId: ctx.tenantId,
          accountId: ctx.accountId,
          teamPlanThreadId: ctx.threadId,
          taskContext: task,
          colleagueLabel,
        }),
      });
    } catch (err) {
      log.error(
        { threadId: ctx.threadId, error: (err as Error).message },
        'preview_with_liftoff: fetch to platform-backend failed',
      );
      return {
        ok: false,
        message:
          'The preview conversation could not be created right now. Tell the person that, and '
          + 'do not try again in this turn.',
      };
    }

    if (!resp.ok) {
      log.error(
        { threadId: ctx.threadId, status: resp.status },
        'preview_with_liftoff: unexpected status from platform-backend',
      );
      return {
        ok: false,
        message: 'The preview conversation could not be created right now.',
      };
    }

    const body = (await resp.json()) as { liftoffThreadId?: string; existing?: boolean };
    if (body.existing) {
      return {
        ok: true,
        message:
          'A preview conversation already exists for this thread. Tell the person to continue '
          + 'in that Liftoff conversation rather than starting another, and to return here when '
          + 'the result looks right.',
      };
    }
    return {
      ok: true,
      message:
        'The preview conversation is ready in Liftoff, opened with your note. Tell the person '
        + 'to continue there and to return here when the result looks right.',
    };
  },
};
