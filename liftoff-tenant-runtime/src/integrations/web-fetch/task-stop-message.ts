// What a browser task that did not finish says for itself.
//
// A stop used to read `Browser task stopped` whatever had happened, and the
// reason lived in a `reason` field and in the trail's steps. The caller is a
// model deciding what to do next and what to tell the person, and neither of
// those is answerable from a bare stop: handed only that sentence, the Chief AI
// Officer can tell the person no more than that the task "stopped before taking
// any steps, reason not fully clear" and ask them to type it themselves, even
// when the stop has a plain cause and a plain remedy.
//
// So every stop carries a sentence with two halves: what happened, and what
// to do about it. The `reason` field stays exactly as it was for the record
// and the tests that pin it; this is what the reason SAYS.
//
// The product's words: no contractions, no em dashes, and the browser is a
// browser rather than anything more animate.

import type { HandoffReason, SelfStopReason } from './jev-loop/types';

/** Every reason a task can stop: the loop's closed set, plus the three a task
 *  can stop for before or after the loop. */
export type TaskStopReason =
  | HandoffReason
  | SelfStopReason
  | 'execution_denied'
  | 'unverified';

export interface StopContext {
  /** The browser was on a blank page when the loop looked at it, so there was
   *  nothing to act on and the task named nowhere to go. */
  blankPage?: boolean;
  /** The loop handed the rest of the task on, and the driver that takes those
   *  over could not start. What the loop could not do stands, and the sentence
   *  says the task did not get a second attempt. */
  tailUnavailable?: boolean;
}

function base(reason: TaskStopReason, ctx: StopContext): string {
  switch (reason) {
    case 'no_candidates':
      return ctx.blankPage
        ? 'The browser was on a blank page, so the task had nothing to act on. '
          + 'Open the page first with the navigate tool, or name the full address in the task, then run the task again.'
        : 'Nothing on the page matched what the task asked for, so no action was taken. '
          + 'Read the page to see what is actually on it, then say which control to use.';
    case 'needs_a_person':
      // Named, and it does NOT hand on. A human-verification wall is not a
      // control to be found: another model driving the same page cannot pass
      // it either, and letting it try spends the task's whole clock on
      // something that was never going to work. The person is asked, in
      // words, in the conversation.
      return 'The site is asking for a human verification step — a CAPTCHA or an "are you human" challenge — '
        + 'and that is not something to attempt. Tell the person plainly that the site wants them to do the check '
        + 'themselves, ask them to do it in the browser beside this conversation and to say when it is done, and '
        + 'name what you will do next once it is. Do not try to solve it, and do not start the task again first.';
    case 'text_not_in_task':
      return 'The task did not carry the exact words to type, so nothing was typed. '
        + 'Put the text to type in quotation marks inside the task, exactly as it should appear, then run it again.';
    case 'new_page':
      return 'The page opened a new tab, and the task stopped there rather than carrying on in a window nobody asked for. '
        + 'Read where the browser is now, then continue from what is in front of you.';
    case 'frame_only':
      return 'What the task needs is inside an embedded frame the browser could not act in. '
        + 'Ask the person to take over for that step.';
    case 'file_input':
      return 'The task reached a step that needs a file to be chosen, which the browser cannot do on its own. '
        + 'Ask the person to take over for that step.';
    case 'constrained':
      return 'The task went as far as it was allowed to and stopped there: the next step would have done something '
        + 'the workspace asks a person to approve first. Nothing was submitted, bought or sent. '
        + 'Read the page to see where it stands, then tell the person what it is waiting on and ask them to take it '
        + 'the rest of the way, or to say it is fine to continue.';
    case 'still_loading':
      return 'The page was still loading after the task waited on it, so the task stopped rather than waiting longer. '
        + 'Read the page to see whether what you asked for has appeared, and run the task again from there.';
    case 'blocked':
      return 'The task ran as far as it could and then stopped without finishing. '
        + 'Read the page to see where it got to before deciding what to do next.';
    case 'timeout':
      return 'The task ran out of time before it finished. '
        + 'Read the page to see how far it got, then continue with a smaller task.';
    case 'execution_denied':
      return 'The browser task did not run, because work is not permitted for this workspace right now. Nothing was done in the browser.';
    case 'unverified':
      return 'The task ran, but the browser could not confirm the result was reached. '
        + 'Read the page to see what actually happened before telling the person it is done.';
    case 'unavailable':
    default:
      return 'The browser task could not start, so nothing was done in the browser. '
        + 'Try it once more; if it still cannot start, tell the person the browser could not be driven just now, and offer to open the page so they can do the step themselves.';
  }
}

/** The sentence a stopped task reports. */
export function taskStopMessage(reason: TaskStopReason, ctx: StopContext = {}): string {
  const sentence = base(reason, ctx);
  // A stop the loop decided, where the driver that would have taken the rest
  // of it over could not start, is one fact more than the reason alone: the
  // part the loop does not do was not attempted at all.
  if (ctx.tailUnavailable && reason !== 'unavailable' && reason !== 'execution_denied') {
    return `${sentence} The rest of the task was not attempted, because the browser could not be driven just now.`;
  }
  return sentence;
}

/** True when a page is one the loop can do nothing with. */
export function isBlankPage(url: string | undefined): boolean {
  const u = (url ?? '').trim();
  return u === '' || u === 'about:blank' || u.startsWith('about:blank');
}
