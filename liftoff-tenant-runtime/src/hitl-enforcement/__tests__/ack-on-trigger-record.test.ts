// Every connector's acknowledgement, not just Gmail's.
//
// `workRole: 'ack'` is authored per connector in the connector service's
// function registry — Gmail's update_message, Outlook's update_message,
// Jira's transition_issue, Zendesk's update_ticket, Linear's update_issue,
// Salesforce's update_lead, and the task connectors' update_task. It names the
// operation that records a work item as handled: the last step of every
// reactive workflow, and the one write that adds no blast radius, because the
// record being written is the record already carrying the untrusted content.
//
// That metadata reached the runtime and was dropped on the way into the gate's
// catalog, so the gate could not tell an acknowledgement from any other write
// and every connector's ack raised an approval card (e.g. "Mark email thread
// <id> as read"). Twelve connectors declare an ack;
// fixing them one host at a time is how the eleven others stay broken.
//
// All three legs must hold, and each fails closed on its own.

import { isInPlaceReply } from '../in-place-reply';

const ack = (over: Record<string, unknown> = {}) => ({
  name: 'zendesk-a1b2__update_ticket',
  input: { ticket_id: 'T-9001', status: 'solved' },
  categories: ['write'],
  workRole: 'ack' as const,
  ...over,
});

describe('a declared ack on the triggering record', () => {
  it('is in place', () => {
    expect(isInPlaceReply(ack(), { source: 'zendesk', id: 'T-9001' })).toBe(true);
  });

  it.each([
    ['jira', { name: 'jira-x__transition_issue', input: { issue_key: 'SUP-42' } }, { source: 'jira', key: 'SUP-42' }],
    ['linear', { name: 'linear-x__update_issue', input: { issueId: 'iss_77' } }, { source: 'linear', id: 'iss_77' }],
    ['salesforce', { name: 'sfdc-x__update_lead', input: { lead_id: '00Q123' } }, { source: 'salesforce', id: '00Q123' }],
    ['outlook', { name: 'outlook-x__update_message', input: { message_id: 'AAMk1' } }, { source: 'microsoft_outlook_mail', id: 'AAMk1' }],
  ])('covers %s without naming it here', (_label, call, target) => {
    expect(isInPlaceReply(ack(call), target)).toBe(true);
  });

  it('matches whichever identifier spelling each side used', () => {
    // The call says thread_id, the trigger says threadId. Same record.
    expect(isInPlaceReply(
      ack({ name: 'gmail-x__update_message', input: { thread_id: '1a025', user_id: 'me' } }),
      { source: 'google_mail', threadId: '1a025' },
    )).toBe(true);
  });
});

describe('each leg fails closed on its own', () => {
  it('refuses a DIFFERENT record', () => {
    // The whole guarantee: acking someone else's ticket is not "in place".
    expect(isInPlaceReply(ack(), { source: 'zendesk', id: 'T-0002' })).toBe(false);
  });

  it('refuses a tool that is not DECLARED an ack', () => {
    // Inferring from the name is what this replaces — an undeclared write on
    // the triggering record still gates.
    expect(isInPlaceReply(ack({ workRole: undefined }), { source: 'zendesk', id: 'T-9001' })).toBe(false);
    expect(isInPlaceReply(ack({ workRole: 'inbox' }), { source: 'zendesk', id: 'T-9001' })).toBe(false);
  });

  it('refuses destructive, outbound or spawning acks', () => {
    for (const over of [
      { categories: ['destructive'] },
      { categories: ['outbound'] },
      { effect: 'spawn' as const },
    ]) {
      expect(isInPlaceReply(ack(over), { source: 'zendesk', id: 'T-9001' })).toBe(false);
    }
  });

  it('refuses when either side names no record', () => {
    expect(isInPlaceReply(ack({ input: { status: 'solved' } }), { source: 'zendesk', id: 'T-9001' })).toBe(false);
    expect(isInPlaceReply(ack(), { source: 'zendesk' })).toBe(false);
  });

  it('does not match on a non-identifier field that happens to be equal', () => {
    // `status` is not an identifier, so an equal value proves nothing.
    expect(isInPlaceReply(
      ack({ input: { status: 'solved' } }),
      { source: 'zendesk', status: 'solved' } as never,
    )).toBe(false);
  });

  it('still refuses with no trigger target at all', () => {
    expect(isInPlaceReply(ack(), undefined)).toBe(false);
  });
});
