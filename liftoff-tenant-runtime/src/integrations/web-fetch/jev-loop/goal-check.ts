// Completion is verified, not declared. A DONE answer is accepted only on a
// fresh page, and then one more request of the browser_goal_check set runs
// over { goal, final: { url, title, text }, recent_actions } with one Noul,
// goal_met: the final observation shows the goal's requirements satisfied —
// the reference's own rule (its AGENTS.md: independent final-outcome
// verification; a DONE choice is not proof of success). `completed: true`
// only when goal_met clears GOAL_T; below it the result is `{ success: true,
// completed: false, reason: 'unverified' }` with the final observation
// attached, so the assistant reports what it sees rather than claiming
// success. One input-only request per task; the probability is recorded on
// the trail's last step, and its usage is posted like any other call.

import { BROWSER_GOAL_CHECK_SET, asEntry } from '../../../typesafe/questions';
import { askForLoop, type LoopCallContext } from './client';
import { RECENT_ACTIONS, type HistoryEntry } from './types';

export interface GoalCheck {
  met: boolean;
  probability: number;
}

export async function checkGoal(
  goal: string,
  final: { url: string; title: string; text: string },
  history: HistoryEntry[],
  ctx: LoopCallContext,
  /** What the caller said finishing looks like. Judged against this when it
   *  is given: an objective says what to do, and a success definition says
   *  how the task can tell it worked, which is the sentence this check
   *  actually needs. */
  opts: { success?: string } = {},
): Promise<GoalCheck | null> {
  const result = await askForLoop(
    BROWSER_GOAL_CHECK_SET,
    asEntry({
      goal,
      ...(opts.success ? { success: opts.success } : {}),
      final,
      recent_actions: history.slice(-RECENT_ACTIONS).map((h) => ({ action: h.action, kind: h.kind, page_changed: h.pageChanged })),
    }),
    ctx,
  );
  if (!result) return null;
  const p = result.answers.goal_met.noul;
  const goalT = BROWSER_GOAL_CHECK_SET.thresholds.GOAL_T as number;
  return { met: p >= goalT, probability: p };
}
