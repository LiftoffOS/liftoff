// A2: what happens to a blocker nobody answered before its window closed.
//
// The pre-existing rule turns an unanswered clarification into a
// `system_internal` escalation. That is right for a question — the moment has
// passed and the context is stale — and wrong for a blocker: "share the sheet
// with the service account" is still true when the window closes, so
// downgrading it moves a live, customer-clearable request into a record only
// operators can read. The run is abandoned and the one person who could have
// fixed it is told nothing. A2.2 forbids exactly that.
//
// cloud-tasks-handler.ts mounts an express router and pulls the execution
// engine transitively, so this asserts the source in the same idiom as the
// other *.source tests in this repo.

import { readFileSync } from 'fs';
import { join } from 'path';

const HANDLER = readFileSync(join(__dirname, '..', 'cloud-tasks-handler.ts'), 'utf8');

/** The clarification-expiry branch, from its guard to the end of the block.
 *
 *  The length is a window, not a measurement: it has to stay comfortably
 *  longer than the branch or these assertions start passing and failing on
 *  where the text happens to land rather than on what the code does. */
const EXPIRY_BLOCK = (() => {
  const start = HANDLER.indexOf("if (kind === 'clarification-expiry')");
  if (start === -1) throw new Error('clarification-expiry branch not found');
  return HANDLER.slice(start, start + 12000);
})();

describe('blocker expiry (A2)', () => {
  it('checks the origin before it escalates anything', () => {
    const originCheck = EXPIRY_BLOCK.indexOf("clarificationOrigin === 'blocker'");
    const escalate = EXPIRY_BLOCK.indexOf('createEscalation');

    expect(originCheck).toBeGreaterThan(-1);
    expect(escalate).toBeGreaterThan(-1);
    // Order is the whole guarantee: a check that runs after the escalation has
    // already been written protects nothing.
    expect(originCheck).toBeLessThan(escalate);
  });

  it('returns from the blocker branch instead of falling through', () => {
    const originCheck = EXPIRY_BLOCK.indexOf("clarificationOrigin === 'blocker'");
    const window = EXPIRY_BLOCK.slice(originCheck, EXPIRY_BLOCK.indexOf('createEscalation'));

    // Marks the row fired (and records the expiry, migration 419), which
    // clears the dedup so the next tick re-raises the blocker, and returns
    // before reaching the system_internal path.
    expect(window).toContain('markClarificationExpiredById');
    expect(window).toMatch(/return res\.status\(200\)/);
  });

  it('keeps the system_internal downgrade for a question', () => {
    // The old behaviour has to survive for the case it was written for.
    expect(EXPIRY_BLOCK).toContain("kind: 'system_internal'");
  });

  it('checks the ask was not already settled before anything else', () => {
    // Nothing cancels this timer when somebody answers or declines, so the
    // task still arrives on a settled row. Without this the handler filed
    // "expired without answer" against a question that had been answered.
    const settledCheck = EXPIRY_BLOCK.indexOf("status !== 'pending'");
    const originCheck = EXPIRY_BLOCK.indexOf("clarificationOrigin === 'blocker'");
    const escalate = EXPIRY_BLOCK.indexOf('createEscalation');

    expect(settledCheck).toBeGreaterThan(-1);
    // First of the three, for the same reason the origin check precedes the
    // escalation: a guard that runs afterwards protects nothing.
    expect(settledCheck).toBeLessThan(originCheck);
    expect(settledCheck).toBeLessThan(escalate);
  });

  it('treats "no pending row remained" as nothing to expire', () => {
    // The only signal available when the task carries no row id: the UPDATE
    // matches 'pending' alone, so zero rows means somebody settled it.
    const window = EXPIRY_BLOCK.slice(0, EXPIRY_BLOCK.indexOf('createEscalation'));

    expect(window).toContain('markClarificationExpiredByInvocationId');
    expect(window).toMatch(/expiredRowCount === 0/);
    expect(window).toContain('already_settled');
  });

  it('does not let a failed origin lookup swallow the expiry', () => {
    // If reading the row throws, the handler must still fall through to the
    // question path rather than leaving the clarification pending forever.
    const originCheck = EXPIRY_BLOCK.indexOf("clarificationOrigin === 'blocker'");
    const window = EXPIRY_BLOCK.slice(originCheck, originCheck + 900);

    expect(window).toMatch(/catch \(/);
  });
});
