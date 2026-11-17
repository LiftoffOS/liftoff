/**
 * A3: the words a person actually reads when a run needs them.
 *
 * "escalated and needs your attention" describes a run that ENDED and left a
 * record behind. Once a customer-clearable blocker parks its run instead of
 * escalating, that sentence is wrong twice: the run has not ended, and the
 * reader is told to go inspect something rather than to do the one thing being
 * asked of them.
 */
import { escalationNotificationTitle } from '../router';

describe('escalationNotificationTitle', () => {
  it('keeps the escalation wording for an escalation', () => {
    expect(escalationNotificationTitle('Ops Copilot', 'escalation')).toBe(
      'Ops Copilot escalated and needs your attention',
    );
  });

  it('says a blocker is blocked, not escalated', () => {
    expect(escalationNotificationTitle('Ops Copilot', 'blocker')).toBe(
      'Ops Copilot is blocked and needs you to act',
    );
  });

  it('says a clarification is a question', () => {
    expect(escalationNotificationTitle('Ops Copilot', 'clarification')).toBe(
      'Ops Copilot has a question before it can continue',
    );
  });

  it('falls back to the escalation wording when the runtime does not say', () => {
    // A tenant-runtime revision that predates the field must keep the wording
    // it has always sent, not silently start describing everything as blocked.
    expect(escalationNotificationTitle('Ops Copilot', undefined)).toBe(
      'Ops Copilot escalated and needs your attention',
    );
  });

  it('obeys the copy rules for every variant', () => {
    const titles = (['escalation', 'blocker', 'clarification', undefined] as const).map(k =>
      escalationNotificationTitle('Ops Copilot', k),
    );
    for (const title of titles) {
      // Never the word "agent" in customer-facing text: the team's own name
      // stands in for it.
      expect(title).not.toMatch(/\bagent\b/i);
      // No em dashes, no contractions.
      expect(title).not.toContain('—');
      expect(title).not.toMatch(/\w'\w/);
    }
  });
});
