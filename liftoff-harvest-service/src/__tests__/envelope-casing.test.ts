// Two producers, two casings, one reader that only knew one of them.
//
// `connector-events-${env}` carries events from platform-backend and
// tenant-runtime in snake_case, and from connector-service's POLLING publisher
// in camelCase (`entityId`, `tenantId`, `entityType`, `connectorId`).
//
// `buildHarvestEvent` read snake_case only. `tenantId` survived by accident —
// it is also a Pub/Sub message ATTRIBUTE — but `entityId` is body-only, so
// every polled record failed the required-field check and was acked away with
// "connector-event missing required fields, acking to drop". Harvest has
// classified nothing from that producer.
//
// The reader absorbs the difference rather than one producer being normalised:
// the topic is shared and neither convention is wrong.

import { buildHarvestEvent } from '../subscriber';
import type { Message } from '@google-cloud/pubsub';

const msg = (attributes: Record<string, string> = {}): Message =>
  ({ id: 'm1', attributes } as unknown as Message);

describe('camelCase envelopes from the polling publisher', () => {
  it('accepts the exact shape publishPollingEvent emits', () => {
    // Verbatim from connector-service/src/polling/event-publisher.ts.
    const envelope = {
      eventId: 'a239502b68ecd7f7-abc123',
      eventUUID: 'uuid-1',
      tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
      connectorId: '14a82d9e-269c-4d56-892a-7d3a9d259c0c',
      entityType: 'Email',
      entityId: 'a239502b68ecd7f7',
      eventType: 'connector.record.synced',
      occurredAt: '2026-08-17T05:38:10.000Z',
      payload: { source: 'google_mail', data: { threadId: 'a239502b68ecd7f7' } },
    };
    const attrs = {
      tenantId: envelope.tenantId,
      entityType: 'Email',
      source: 'google_mail',
      eventType: 'connector.record.synced',
      connectorId: envelope.connectorId,
    };

    const out = buildHarvestEvent(msg(attrs), envelope);

    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      tenantId: envelope.tenantId,
      entityId: 'a239502b68ecd7f7',
      entityType: 'Email',
      connectorType: 'google_mail',
      connectorId: envelope.connectorId,
    });
  });

  it('resolves entityId from the body, which no attribute carries', () => {
    // The precise reason the drop happened: entityId is body-only. If this
    // regresses, every polled record silently disappears again.
    const out = buildHarvestEvent(
      msg({ tenantId: 't1', source: 'google_mail' }),
      { entityId: 'e1', tenantId: 't1', payload: { data: {} } },
    );
    expect(out?.entityId).toBe('e1');
  });
});

describe('snake_case envelopes still work', () => {
  it('accepts the platform-backend / tenant-runtime shape unchanged', () => {
    const out = buildHarvestEvent(
      msg({}),
      {
        event_id: 'evt-1',
        tenant_id: 't1',
        entity_id: 'e1',
        entity_type: 'Email',
        connector_type: 'google_mail',
        connector_id: 'c1',
        payload: { data: {} },
      },
    );
    expect(out).toMatchObject({
      tenantId: 't1', entityId: 'e1', entityType: 'Email',
      connectorType: 'google_mail', connectorId: 'c1',
    });
  });

  it('prefers snake_case when a message somehow carries both', () => {
    // Arbitrary but fixed: the older convention wins, so behaviour for existing
    // producers cannot shift.
    const out = buildHarvestEvent(
      msg({}),
      { entity_id: 'snake', entityId: 'camel', tenant_id: 't1', payload: { data: {} } },
    );
    expect(out?.entityId).toBe('snake');
  });
});

describe('genuinely incomplete events are still dropped', () => {
  it('returns null when no casing supplies an entity id', () => {
    expect(buildHarvestEvent(msg({ tenantId: 't1' }), { tenantId: 't1', payload: { data: {} } }))
      .toBeNull();
  });

  it('returns null when no casing supplies a tenant id', () => {
    expect(buildHarvestEvent(msg({}), { entityId: 'e1', payload: { data: {} } })).toBeNull();
  });
});
