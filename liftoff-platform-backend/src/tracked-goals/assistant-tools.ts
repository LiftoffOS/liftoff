// Holding onto a goal, for the assistant the person told it to.
//
// The thing that makes a goal a goal rather than a note is that it is read
// back into the assistant's context on EVERY turn (`goalsSection` below), so
// the next conversation starts knowing the commitment exists. Storing one
// without that injection would be a table nobody reads.
//
// It executes nothing. No schedule, no run, no background pass: the work
// happens where work already happens, and this is what remembers it was
// supposed to. Saying so plainly in the tool descriptions matters, because a
// model told it is "tracking" something will otherwise tell the person it is
// working on it.

import type { LLMToolDefinition } from '../llm/types';
import { log } from '../infrastructure/logging';
import { completeGoal, countActiveGoals, createGoal, listGoals, MAX_ACTIVE_GOALS } from './repository';

export const GOAL_TRACK_TOOL = 'track_goal';
export const GOAL_FINISH_TOOL = 'finish_goal';

const TITLE_CAP = 200;
const DESCRIPTION_CAP = 2_000;

export const trackGoalTool: LLMToolDefinition = {
  name: GOAL_TRACK_TOOL,
  description:
    'Hold onto something the person wants kept in view beyond this conversation: an outcome they are working '
    + 'towards, a commitment they made, something they asked you to keep an eye on. It is read back to you at '
    + 'the start of every conversation with them, so you will know it exists without being told again. '
    + 'Use it when the person says they want something remembered or tracked, or when they describe an outcome '
    + 'they will come back to. Do not use it for a one-off request you can finish now, and do not use it to '
    + 'store notes, results or workings: those belong in the conversation and in the work itself. '
    + 'THIS DOES NO WORK. Nothing runs because a goal exists. If the person wants the work done regularly, that '
    + 'is an agent on a schedule, and you should say so rather than letting a goal stand in for one.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The goal in one short line, in the person\'s own terms.',
      },
      description: {
        type: 'string',
        description: 'What the person said about it: what done looks like, and anything that matters for later. Optional.',
      },
    },
    required: ['title'],
  },
};

export const finishGoalTool: LLMToolDefinition = {
  name: GOAL_FINISH_TOOL,
  description:
    'Mark a goal the person has finished with, so it stops being read back to you. Use it when they say it is '
    + 'done, or when the outcome it describes has plainly been reached. A goal is either being worked or it is '
    + 'finished: there is no pausing one. If the person no longer wants it at all, say so and finish it.',
  input_schema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'The id of the goal, as it was read back to you.' },
    },
    required: ['goal_id'],
  },
};

export const trackedGoalTools: LLMToolDefinition[] = [trackGoalTool, finishGoalTool];

export function isTrackedGoalTool(name: string): boolean {
  return name === GOAL_TRACK_TOOL || name === GOAL_FINISH_TOOL;
}

export interface GoalToolContext {
  tenantId: string;
  /** The person whose goal it is. Absent on a turn with no resolved person,
   *  which this refuses rather than filing a goal under nobody. */
  accountId?: string;
}

/**
 * Run one, and answer in the words the model will relay.
 *
 * A string rather than a structure, like the file and dataset tools beside
 * it: what comes back is read by a model and paraphrased to a person.
 */
export async function runTrackedGoalTool(
  name: string,
  input: Record<string, unknown>,
  ctx: GoalToolContext,
): Promise<string> {
  if (!ctx.accountId) {
    // A goal belongs to the person who asked for it, and one filed under
    // nobody is one nobody can be asked about or close.
    return 'A goal can only be held for a person, and this conversation has none resolved.';
  }
  try {
    if (name === GOAL_TRACK_TOOL) {
      const title = typeof input.title === 'string' ? input.title.trim().slice(0, TITLE_CAP) : '';
      if (!title) return 'That needs the goal in one short line.';
      const description = typeof input.description === 'string'
        ? input.description.trim().slice(0, DESCRIPTION_CAP)
        : '';
      const open = await countActiveGoals(ctx.tenantId, ctx.accountId);
      if (open >= MAX_ACTIVE_GOALS) {
        return `This person already has ${open} goals being tracked, which is as many as are useful to carry. `
          + 'Ask them which of the existing ones is finished before adding another.';
      }
      const goal = await createGoal({ tenantId: ctx.tenantId, accountId: ctx.accountId, title, description });
      return `Held onto: "${goal.title}". It will be read back to you at the start of every conversation with `
        + 'them until it is finished. Nothing runs because of it.';
    }

    const goalId = typeof input.goal_id === 'string' ? input.goal_id.trim() : '';
    if (!goalId) return 'That needs the id of the goal to finish.';
    const finished = await completeGoal(ctx.tenantId, ctx.accountId, goalId);
    if (!finished) return 'No goal of theirs with that id is still being tracked. It may already be finished.';
    return `Finished: "${finished.title}". It will not be read back to you again.`;
  } catch (err) {
    log.error({ err: (err as Error).message, tool: name, tenantId: ctx.tenantId }, 'tracked goal tool failed');
    return 'That could not be done just now. Tell the person plainly rather than trying again in this turn.';
  }
}

/**
 * The goals this person is being held to, for the system prompt.
 *
 * THIS is what makes a goal a goal. Everything else here is a table. Empty
 * when they have none, so a person with no goals carries no section and no
 * instruction about one.
 */
export async function goalsSection(tenantId: string, accountId: string | undefined): Promise<string> {
  if (!accountId) return '';
  try {
    const goals = await listGoals(tenantId, accountId);
    if (goals.length === 0) return '';
    const lines = goals.map((g) => `- ${g.title}${g.description ? `: ${g.description}` : ''} (id ${g.id})`);
    return [
      '## What this person is working towards',
      'They asked you to hold onto these. They are here every time you speak, so you never need to be told again.',
      'Nothing runs because one of these exists: they are what you remember, not work in progress. Bring one up when '
      + `it is relevant to what they are asking, not otherwise. When one is finished, close it with \`${GOAL_FINISH_TOOL}\`.`,
      ...lines,
    ].join('\n');
  } catch (err) {
    // A turn never fails over its goals section.
    log.warn({ err: (err as Error).message, tenantId }, 'goals section could not be read');
    return '';
  }
}
