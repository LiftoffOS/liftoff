import { shouldAttemptClassification, extractText } from '../filter';
import type { HarvestEvent } from '../types';

function makeEvent(partial: Partial<HarvestEvent>): HarvestEvent {
  return {
    tenantId: 't1',
    connectorId: null,
    connectorType: 'slack',
    entityType: 'Message',
    entityId: 'e1',
    data: {},
    messageId: 'm1',
    ...partial,
  };
}

const LONG_TEXT = 'a'.repeat(150);
const SHORT_TEXT = 'a'.repeat(149);

describe('extractText', () => {
  it('returns null when no text fields present', () => {
    const event = makeEvent({ data: { foo: 'bar', count: 5 } });
    expect(extractText(event)).toBeNull();
  });

  it('returns null when result is shorter than MIN_HARVEST_LENGTH', () => {
    const event = makeEvent({ data: { body: 'short body' } });
    expect(extractText(event)).toBeNull();
  });

  it('concatenates title + body when both present', () => {
    const title = 'Architectural decision: '.padEnd(40, 'x');
    const body = 'We chose Postgres because '.padEnd(150, 'y');
    const event = makeEvent({ data: { title, body } });
    const out = extractText(event);
    expect(out).not.toBeNull();
    expect(out).toContain(title);
    expect(out).toContain(body);
  });

  it('returns null when only whitespace text fields are present', () => {
    const event = makeEvent({ data: { body: '   ', title: '\n\n' } });
    expect(extractText(event)).toBeNull();
  });
});

describe('shouldAttemptClassification', () => {
  const blocked = [
    'Contact', 'CalendarEvent', 'Task', 'User', 'Label', 'Team',
    'Channel', 'Reaction', 'Event', 'Folder',
  ];

  for (const entityType of blocked) {
    it(`returns false for blocked entity type ${entityType}`, () => {
      const event = makeEvent({ entityType, data: { body: LONG_TEXT } });
      expect(shouldAttemptClassification(event)).toBe(false);
    });
  }

  it('returns false when text is shorter than MIN_HARVEST_LENGTH (149 chars)', () => {
    const event = makeEvent({ data: { body: SHORT_TEXT } });
    expect(shouldAttemptClassification(event)).toBe(false);
  });

  it('returns true when text is exactly MIN_HARVEST_LENGTH (150 chars)', () => {
    const event = makeEvent({ data: { body: LONG_TEXT } });
    expect(shouldAttemptClassification(event)).toBe(true);
  });

  it('returns false for blocked mimeType image/png', () => {
    const event = makeEvent({ data: { body: LONG_TEXT, mimeType: 'image/png' } });
    expect(shouldAttemptClassification(event)).toBe(false);
  });

  it('returns false for blocked mimeType video/mp4', () => {
    const event = makeEvent({ data: { body: LONG_TEXT, mimeType: 'video/mp4' } });
    expect(shouldAttemptClassification(event)).toBe(false);
  });

  it('returns true for allowed mimeType text/plain', () => {
    const event = makeEvent({ data: { body: LONG_TEXT, mimeType: 'text/plain' } });
    expect(shouldAttemptClassification(event)).toBe(true);
  });

  it('returns true for allowed mimeType application/vnd.google-apps.document', () => {
    const event = makeEvent({
      data: { body: LONG_TEXT, mimeType: 'application/vnd.google-apps.document' },
    });
    expect(shouldAttemptClassification(event)).toBe(true);
  });
});
