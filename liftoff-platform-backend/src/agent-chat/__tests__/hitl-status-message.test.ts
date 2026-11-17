import { waitingMessage, decisionMessage } from '../hitl-status-message';
import type { ApprovalRouteDescription } from '../approval-route-description';

// These strings are read by everyone in the thread, not just the person being
// asked, which is the whole reason they differ from the banner's wording. The
// banner says "your review" because it renders only for people who must act; a
// persisted row has no such luxury and must stay third person.

function route(over: Partial<ApprovalRouteDescription> = {}): ApprovalRouteDescription {
  return { names: [], accountIds: [], toAdmins: false, unassigned: false, ...over };
}

describe('waitingMessage', () => {
  it('names one person', () => {
    expect(waitingMessage(route({ names: ['Ada Lovelace'] })))
      .toBe('Waiting on Ada Lovelace to approve before continuing.');
  });

  it('names two people in full', () => {
    expect(waitingMessage(route({ names: ['Ada Lovelace', 'Grace Hopper'] })))
      .toBe('Waiting on Ada Lovelace and Grace Hopper to approve before continuing.');
  });

  it('summarises a longer list rather than growing without bound', () => {
    expect(waitingMessage(route({ names: ['Ada', 'Grace', 'Alan', 'Katherine'] })))
      .toBe('Waiting on Ada, Grace and 2 others to approve before continuing.');
  });

  // No assignee could act, so it escalated. These are whoever holds the role
  // today, not people anyone picked for this team, so name the role.
  it('describes an admin fallback by role', () => {
    expect(waitingMessage(route({ toAdmins: true })))
      .toBe('Waiting on a workspace admin to approve before continuing.');
  });

  it('describes an unassigned team as open to the workspace', () => {
    expect(waitingMessage(route({ unassigned: true })))
      .toBe('Waiting on a workspace member to approve before continuing.');
  });

  // Route resolution is best-effort. Saying something vague and true beats
  // naming somebody who was never asked.
  it('stays vague when no route resolved', () => {
    expect(waitingMessage(route())).toBe('Waiting on a review before continuing.');
  });

  // The banner is per-reader and may say "your"; this row is shared and must not.
  it('never addresses the reader', () => {
    const all = [
      waitingMessage(route({ names: ['Ada'] })),
      waitingMessage(route({ toAdmins: true })),
      waitingMessage(route({ unassigned: true })),
      waitingMessage(route()),
    ];
    for (const text of all) {
      expect(text).not.toMatch(/\byour\b/i);
      expect(text).not.toMatch(/\byou\b/i);
    }
  });
});

describe('decisionMessage', () => {
  it('names who approved', () => {
    expect(decisionMessage('approved', 'Ada Lovelace')).toBe('Approved by Ada Lovelace.');
  });

  it('names who rejected', () => {
    expect(decisionMessage('rejected', 'Ada Lovelace')).toBe('Rejected by Ada Lovelace.');
  });

  // Falls back rather than printing an account id, which would mean nothing to
  // anyone reading the conversation.
  it('omits the name when it could not be resolved', () => {
    expect(decisionMessage('approved', null)).toBe('Approved.');
    expect(decisionMessage('rejected', undefined)).toBe('Rejected.');
  });
});
