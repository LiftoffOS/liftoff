// Tests for thread-id-resolver — pre-flight thread/conversation entityId
// extraction from a trigger payload.
//
// The function bridges two delivery shapes:
//   1. inputData wrapper produced by event-trigger.ts (eventSource +
//      eventEntityType + eventData)
//   2. Composio snake_case payload keys vs older camelCase direct-vendor keys
//
// Earlier this code only handled the camelCase variant AND received the
// dispatcher wrapper directly without descending into eventData, so every
// event-triggered invocation skipped the thread prefetch silently. Pin
// both shapes here so any future regression fails loudly.

import { resolveEntityId } from '../thread-id-resolver';

describe('resolveEntityId — event-trigger inputData unwrap', () => {
  it('descends into eventData when the dispatcher wrapper is passed in', () => {
    const inputData = {
      eventSource: 'google_mail',
      eventEntityType: 'Email',
      eventData: { thread_id: 'thread_abc' },
    };
    expect(resolveEntityId(inputData, 'google_mail', 'thread')).toBe('thread_abc');
  });

  it('falls through to the top-level payload when eventData is absent (direct webhook path)', () => {
    expect(
      resolveEntityId({ thread_id: 'thread_xyz' }, 'google_mail', 'thread'),
    ).toBe('thread_xyz');
  });
});

describe('resolveEntityId — Composio snake_case + camelCase fallback', () => {
  it('google_mail/thread reads Composio thread_id', () => {
    expect(resolveEntityId({ thread_id: 'tA' }, 'google_mail', 'thread')).toBe('tA');
  });

  it('google_mail/thread falls back to camelCase threadId for the legacy direct-watch path', () => {
    expect(resolveEntityId({ threadId: 'tB' }, 'google_mail', 'thread')).toBe('tB');
  });

  it('microsoft_outlook_mail/conversation prefers conversation_id', () => {
    expect(
      resolveEntityId({ conversation_id: 'cA' }, 'microsoft_outlook_mail', 'conversation'),
    ).toBe('cA');
    expect(
      resolveEntityId({ conversationId: 'cB' }, 'microsoft_outlook_mail', 'conversation'),
    ).toBe('cB');
  });

  it('slack/thread composes channel + ts (Composio shape uses snake_case `thread_ts`)', () => {
    expect(
      resolveEntityId({ channel: 'C1', thread_ts: '123.456' }, 'slack', 'thread'),
    ).toBe('C1:123.456');
    // Falls back to `ts` when thread_ts is absent.
    expect(
      resolveEntityId({ channel: 'C1', ts: '789.012' }, 'slack', 'thread'),
    ).toBe('C1:789.012');
  });

  it('microsoft_teams/thread composes team_id + channel_id + message_id (all snake_case)', () => {
    expect(
      resolveEntityId(
        { team_id: 'T', channel_id: 'C', message_id: 'M' },
        'microsoft_teams',
        'thread',
      ),
    ).toBe('T:C:M');
  });

  it('zendesk/comments prefers ticket_id, then ticketId, then id', () => {
    expect(resolveEntityId({ ticket_id: '1' }, 'zendesk', 'comments')).toBe('1');
    expect(resolveEntityId({ ticketId: '2' }, 'zendesk', 'comments')).toBe('2');
    expect(resolveEntityId({ id: '3' }, 'zendesk', 'comments')).toBe('3');
  });

  it('jira/comments accepts both snake_case issue_id and camelCase issueId', () => {
    expect(resolveEntityId({ issue_id: 'I1' }, 'atlassian_jira', 'comments')).toBe('I1');
    expect(resolveEntityId({ issueId: 'I2' }, 'atlassian_jira', 'comments')).toBe('I2');
    expect(resolveEntityId({ key: 'PROJ-3' }, 'atlassian_jira', 'comments')).toBe('PROJ-3');
  });

  it('salesforce/activity prefers record_id, falls back to recordId, then id', () => {
    expect(resolveEntityId({ record_id: 'R1' }, 'salesforce', 'activity')).toBe('R1');
    expect(resolveEntityId({ recordId: 'R2' }, 'salesforce', 'activity')).toBe('R2');
    expect(resolveEntityId({ id: 'R3' }, 'salesforce', 'activity')).toBe('R3');
  });

  it('returns null when the connector is not registered', () => {
    expect(resolveEntityId({ id: 'anything' }, 'unknown_connector', 'thread')).toBeNull();
  });

  it('returns null when the entityType is not registered for the connector', () => {
    expect(resolveEntityId({ thread_id: 't1' }, 'google_mail', 'unknown_entity')).toBeNull();
  });

  it('returns null when none of the expected keys are present', () => {
    expect(resolveEntityId({}, 'google_mail', 'thread')).toBeNull();
    expect(resolveEntityId({ unrelated: 'x' }, 'google_mail', 'thread')).toBeNull();
  });

  it('ignores empty-string values (treats them as absent)', () => {
    expect(resolveEntityId({ thread_id: '' }, 'google_mail', 'thread')).toBeNull();
  });
});

describe('resolveEntityId — end-to-end Composio Gmail reproducer', () => {
  it('extracts the thread id from the exact wire shape event-trigger.ts hands in', () => {
    // Mirrors src/scheduling/event-trigger.ts:486-491 — Composio's
    // GMAIL_NEW_GMAIL_MESSAGE payload nested under eventData.
    const inputData = {
      eventSource: 'google_mail',
      eventEntityType: 'Email',
      eventData: {
        id: 'msg_abc',
        message_id: 'msg_abc',
        thread_id: 'thread_real_value',
        message_timestamp: '2026-06-10T22:01:00Z',
        subject: 'Help',
        sender: 'customer@example.com',
        to: 'support@example.com',
        message_text: 'Hello',
        label_ids: ['INBOX', 'UNREAD'],
      },
    };
    expect(resolveEntityId(inputData, 'google_mail', 'thread')).toBe('thread_real_value');
  });
});
