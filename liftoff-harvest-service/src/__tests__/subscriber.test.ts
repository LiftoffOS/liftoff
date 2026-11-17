jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({
    subscription: jest.fn(),
  })),
  Message: class {},
}));

jest.mock('../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../runner', () => ({
  runHarvestPipeline: jest.fn().mockResolvedValue(undefined),
}));

import { buildHarvestEvent } from '../subscriber';

interface FakeMessage {
  id: string;
  attributes: Record<string, string>;
  data: Buffer;
  ack: jest.Mock;
  nack: jest.Mock;
}

function makeMessage(attrs: Record<string, string> = {}): FakeMessage {
  return {
    id: 'msg-id-123',
    attributes: attrs,
    data: Buffer.from('{}'),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

describe('buildHarvestEvent', () => {
  it('returns null when tenantId is missing', () => {
    const msg = makeMessage();
    const out = buildHarvestEvent(msg as never, { entity_id: 'e1' });
    expect(out).toBeNull();
  });

  it('returns null when entityId is missing', () => {
    const msg = makeMessage();
    const out = buildHarvestEvent(msg as never, { tenant_id: 't1' });
    expect(out).toBeNull();
  });

  it('reads connectorId from message attributes', () => {
    const msg = makeMessage({
      tenant_id: 't1',
      entity_id: 'e1',
      connector_id: 'attr-conn',
    });
    const out = buildHarvestEvent(msg as never, {
      tenant_id: 't1',
      entity_id: 'e1',
    });
    expect(out?.connectorId).toBe('attr-conn');
  });

  it('reads connectorId from envelope body when not present in attributes', () => {
    const msg = makeMessage({ tenant_id: 't1', entity_id: 'e1' });
    const out = buildHarvestEvent(msg as never, {
      tenant_id: 't1',
      entity_id: 'e1',
      connector_id: 'body-conn',
    });
    expect(out?.connectorId).toBe('body-conn');
  });

  it('sets connectorId to null when not present anywhere', () => {
    const msg = makeMessage({ tenant_id: 't1', entity_id: 'e1' });
    const out = buildHarvestEvent(msg as never, {
      tenant_id: 't1',
      entity_id: 'e1',
    });
    expect(out?.connectorId).toBeNull();
  });

  it('reads entityType from attributes', () => {
    const msg = makeMessage({
      tenant_id: 't1',
      entity_id: 'e1',
      entity_type: 'Message',
    });
    const out = buildHarvestEvent(msg as never, {
      tenant_id: 't1',
      entity_id: 'e1',
    });
    expect(out?.entityType).toBe('Message');
  });

  it('falls back to envelope.entity_type when attributes are missing', () => {
    const msg = makeMessage({ tenant_id: 't1', entity_id: 'e1' });
    const out = buildHarvestEvent(msg as never, {
      tenant_id: 't1',
      entity_id: 'e1',
      entity_type: 'Document',
    });
    expect(out?.entityType).toBe('Document');
  });

  it('reads connectorType from attribute source then envelope.source', () => {
    const fromAttr = buildHarvestEvent(
      makeMessage({ tenant_id: 't1', entity_id: 'e1', source: 'slack' }) as never,
      { tenant_id: 't1', entity_id: 'e1' },
    );
    expect(fromAttr?.connectorType).toBe('slack');

    const fromBody = buildHarvestEvent(
      makeMessage({ tenant_id: 't1', entity_id: 'e1' }) as never,
      { tenant_id: 't1', entity_id: 'e1', source: 'gmail' },
    );
    expect(fromBody?.connectorType).toBe('gmail');
  });

  it('carries the Pub/Sub message id through to the harvest event', () => {
    const msg = makeMessage({ tenant_id: 't1', entity_id: 'e1' });
    const out = buildHarvestEvent(msg as never, {
      tenant_id: 't1',
      entity_id: 'e1',
    });
    expect(out?.messageId).toBe('msg-id-123');
  });
});
