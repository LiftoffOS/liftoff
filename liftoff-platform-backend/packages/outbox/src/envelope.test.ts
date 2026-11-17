import { deserializeEnvelope, serializeEnvelope, type EventEnvelope } from './envelope.js';

describe('envelope', () => {
  it('round-trips an envelope without losing fields', () => {
    const original: EventEnvelope<{ amount: number }> = {
      eventId: '00000000-0000-0000-0000-000000000001',
      eventType: 'billing.invoice.created',
      schemaVersion: 1,
      tenantId: '11111111-2222-3333-4444-555555555555',
      occurredAt: new Date('2026-04-20T12:00:00.000Z'),
      sourceService: 'liftoff-billing',
      traceId: '00-abc-def-00',
      payload: { amount: 42 },
    };
    const raw = serializeEnvelope(original);
    const round = deserializeEnvelope<{ amount: number }>(raw);
    expect(round.eventId).toBe(original.eventId);
    expect(round.eventType).toBe(original.eventType);
    expect(round.schemaVersion).toBe(original.schemaVersion);
    expect(round.tenantId).toBe(original.tenantId);
    expect(round.occurredAt.toISOString()).toBe(original.occurredAt.toISOString());
    expect(round.sourceService).toBe(original.sourceService);
    expect(round.traceId).toBe(original.traceId);
    expect(round.payload).toEqual(original.payload);
  });

  it('accepts Buffer input', () => {
    const env: EventEnvelope = {
      eventId: 'e',
      eventType: 't',
      schemaVersion: 1,
      tenantId: 'x',
      occurredAt: new Date('2026-04-20T12:00:00.000Z'),
      sourceService: 'svc',
      traceId: null,
      payload: {},
    };
    const buf = Buffer.from(serializeEnvelope(env), 'utf-8');
    expect(deserializeEnvelope(buf).eventId).toBe('e');
  });
});
