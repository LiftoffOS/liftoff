// G2 — the repair loop fires on a constructed wired-at-one-end scenario.
//
// The scenario IS the defect class this whole program is about, reproduced
// deliberately: an agent is told to do something outward, does everything
// except that, and finishes with nothing in an error state. The run is recorded
// as a success and the thing the person asked for did not happen.

import {
  assessRepair,
  buildRepairReminder,
  isRepairReminder,
  REPAIR_REMINDER_MARKER,
} from '../repair-loop';

describe('G2: the constructed wired-at-one-end scenario', () => {
  it('FIRES when the objective says send and no outward call happened', () => {
    // An agent reviews a pull request, posts a substantive review, and replies
    // nothing — while every layer below it works.
    const a = assessRepair({
      objective: 'Review the pull request and send the author a summary.',
      outwardToolsCalled: 0,
      hasOutwardTool: true,
    });
    expect(a.needsRepair).toBe(true);
    expect(a.impliedVerb).toBe('send');
  });

  it('does NOT fire when the outward action happened', () => {
    // This is not a quality check. A turn that called an outward tool has done
    // the thing, whatever else it may have got wrong.
    expect(assessRepair({
      objective: 'Review the pull request and send the author a summary.',
      outwardToolsCalled: 1,
      hasOutwardTool: true,
    }).needsRepair).toBe(false);
  });

  it('does NOT fire when the objective implies nothing outward', () => {
    // A research question is complete when it is answered.
    expect(assessRepair({
      objective: 'What did we decide about the pricing model?',
      outwardToolsCalled: 0,
      hasOutwardTool: true,
    }).needsRepair).toBe(false);
  });

  it('does NOT fire when the agent has no outward tool', () => {
    // The reminder would be an instruction to use a tool it does not have,
    // which is worse than silence: it is a demand it cannot satisfy.
    expect(assessRepair({
      objective: 'Send the summary.',
      outwardToolsCalled: 0,
      hasOutwardTool: false,
    }).needsRepair).toBe(false);
  });

  it('matches whole words', () => {
    // "resend" contains "send"; "addendum" contains "add". A substring match
    // would fire the loop on prose that implied no action at all.
    expect(assessRepair({
      objective: 'Summarise the addendum.',
      outwardToolsCalled: 0,
      hasOutwardTool: true,
    }).needsRepair).toBe(false);
  });
});

describe('the correction is ONE, and NAMED', () => {
  it('names the action rather than saying the turn failed', () => {
    // A model told it failed generically re-narrates what it already did.
    const r = buildRepairReminder('send');
    expect(r).toContain('asked to send');
    expect(r).toContain('Do it now');
  });

  it('says it is the only reminder', () => {
    // A model that believes it will be asked again has a reason to defer.
    expect(buildRepairReminder('post')).toContain('only reminder');
  });
});

describe('the reminder is excluded from memory extraction', () => {
  it('is identifiable by a marker, not a heuristic', () => {
    // Extraction must not have to guess which user turns were really the host.
    expect(isRepairReminder(`x ${REPAIR_REMINDER_MARKER} y`)).toBe(true);
    expect(isRepairReminder('Please send the summary.')).toBe(false);
    expect(isRepairReminder(undefined)).toBe(false);
  });
});
