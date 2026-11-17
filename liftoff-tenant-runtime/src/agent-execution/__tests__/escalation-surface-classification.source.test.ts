// What reaches the customer review queue, and what stays operator-side.
//
// The queue is a place people are asked to look at every day, so its value is
// set by its worst item. A card reading `permanent tool error x2 on "Bash"
// (internal_error) — not retryable` gives the reader nothing to do; a few of
// those and the queue becomes something to scroll past, which costs the
// escalations that genuinely need a person.
//
// The rule is about the READER, not the severity: 'escalation' only when a
// human decision or action unblocks the agent AND the reason was written for a
// human. Reasons assembled by code from internal state — retry counters, tool
// error codes, cap exhaustion, context limits — are 'system_internal'. They
// stay recorded and stay queryable; they just are not put in front of someone
// who cannot act on them.
//
// service.ts pulls DB + SDK transitively, so this asserts the source in the
// same idiom as the other *.source tests.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const HELPER = readFileSync(join(__dirname, '..', 'engine', 'escalation-helper.ts'), 'utf8');

/** The escalation call immediately following a given reason assignment. */
function kindForReason(reasonFragment: string): string | null {
  const at = SERVICE.indexOf(reasonFragment);
  if (at === -1) return null;
  const window = SERVICE.slice(at, at + 900);
  const match = window.match(/createEscalation\([\s\S]{0,400}?kind: '(escalation|system_internal)'/);
  return match ? match[1] : null;
}

describe('machine-assembled reasons stay off the customer queue', () => {
  it.each([
    ['retry counters', 'const reason = `recovery cap exceeded (per-step='],
    ['tool error codes', 'const reason = `permanent tool error x${permCount}'],
    ['context exhaustion', "const reason = 'This conversation reached the model context limit"],
    ['connector contract codes', 'const reason = `${e.contract.code}: ${e.contract.recovery}`'],
  ])('%s are operator material', (_label, fragment) => {
    expect(kindForReason(fragment)).toBe('system_internal');
  });
});

describe('agent-authored reasons reach the person only when they can act', () => {
  // "A human must act" was one audience covering two. The model writes the
  // reason for a person either way, so the reason alone never separated a
  // customer who can grant access from us fixing a broken connector — and the
  // recovery prompt actively told it to escalate environmental faults. The
  // model now says who can unblock it, and that answer decides the surface.
  it('a recovery decision routes by audience rather than a fixed surface', () => {
    // The audience decides the surface, and a customer-facing kind is read
    // by the ask check first (escalationSurfaceAfterAskCheck): nobody in the
    // workspace able to act moves it to an operator record.
    expect(SERVICE).toMatch(/kind: escalationKindFor\(decision\)[\s\S]{0,120}decision\.escalationReason \?\? 'Agent escalated/);
    expect(SERVICE).toMatch(/escalationSurfaceAfterAskCheck\(state, \{\s*kind: escalationKindFor\(decision\)/);
  });

  it('a customer-clearable blocker parks the run instead of ending it', () => {
    // Parking is what makes the answer worth anything: an ended run has
    // nothing left to resume, which is why escalations were a queue of
    // notices nobody could act on.
    expect(SERVICE).toMatch(/customerCanUnblock\(decision\)[\s\S]{0,800}createClarificationPause/);
  });

  it('a reported task outcome and an [ESCALATE] marker both route by audience', () => {
    expect(SERVICE).toMatch(/escalationKindFor\(\{ whoCanUnblock: reportedOutcome\.whoCanUnblock \}\)[\s\S]{0,200}reportedOutcome\.summary/);
    expect(SERVICE).toMatch(/escalationKindFor\(\{ whoCanUnblock: marker\.whoCanUnblock \}\)[\s\S]{0,200}marker\.reason/);
  });

  it('an approval the person must grant stays user-facing', () => {
    expect(SERVICE).toMatch(/HITL approval required for loop step[\s\S]{0,400}kind: 'escalation'/);
  });
});

describe('the contract is documented where the choice is made', () => {
  it('the options type states the reader test, not a severity test', () => {
    expect(HELPER).toMatch(/does a person[\s\S]{0,20}reading this reason have something to DO/i);
    expect(HELPER).toContain('system_internal');
  });
});
