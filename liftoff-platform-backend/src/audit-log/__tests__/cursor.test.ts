import { encodeCursor, decodeCursor } from '../cursor';
import { CursorPayload } from '../types';

describe('audit-log cursor', () => {
  const validCursor: CursorPayload = {
    occurredAt: '2026-05-21T12:00:00.000Z',
    source: 'audit_log',
    rowId: '11111111-1111-1111-1111-111111111111',
  };

  it('round-trips a valid cursor', () => {
    const encoded = encodeCursor(validCursor);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(validCursor);
  });

  it('returns null for invalid base64', () => {
    expect(decodeCursor('not%a%valid%base64')).toBeNull();
  });

  it('returns null for non-JSON payload', () => {
    const bogus = Buffer.from('not-json').toString('base64url');
    expect(decodeCursor(bogus)).toBeNull();
  });

  it('returns null for unknown source', () => {
    const payload = { ...validCursor, source: 'unknown_source' };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('returns null when occurredAt is missing', () => {
    const payload = { source: 'audit_log', rowId: 'abc' };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('returns null when rowId is missing', () => {
    const payload = { occurredAt: '2026-05-21T12:00:00.000Z', source: 'audit_log' };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('returns null when occurredAt is not a string', () => {
    const payload = { occurredAt: 123, source: 'audit_log', rowId: 'abc' };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('accepts each of the six known sources', () => {
    const sources = [
      'tenant_member_audit',
      'audit_log',
      'internal_agent_audit',
      'agent_chat_messages',
      'agent_audit_logs',
      'event_deliveries',
    ] as const;
    for (const source of sources) {
      const encoded = encodeCursor({ ...validCursor, source });
      const decoded = decodeCursor(encoded);
      expect(decoded?.source).toBe(source);
    }
  });
});
