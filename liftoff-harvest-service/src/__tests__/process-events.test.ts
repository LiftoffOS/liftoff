// Unit tests for the extracted per-message decision functions (the live push
// path) and the Pub/Sub push envelope decoder. The pipeline + disconnect
// handler are mocked so these stay hermetic (no DB / LLM).

jest.mock('../runner', () => ({ runHarvestPipeline: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../disconnect-handler', () => ({ handleConnectorDeleted: jest.fn().mockResolvedValue(undefined) }));

import { processConnectorEvent } from '../subscriber';
import { processControlPlaneEvent } from '../control-plane-subscriber';
import { decodePush } from '../routes/pubsub';
import { runHarvestPipeline } from '../runner';
import { handleConnectorDeleted } from '../disconnect-handler';

const mockedRun = runHarvestPipeline as jest.MockedFunction<typeof runHarvestPipeline>;
const mockedDelete = handleConnectorDeleted as jest.MockedFunction<typeof handleConnectorDeleted>;

const connectorBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ tenant_id: 't1', entity_id: 'e1', connector_type: 'salesforce', ...over });

describe('processConnectorEvent', () => {
  beforeEach(() => mockedRun.mockClear());

  it('acks (drops) an unparseable body without harvesting', async () => {
    expect(await processConnectorEvent('{not json', {}, 'm1')).toBe('ack');
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('acks (drops) when tenant/entity are missing', async () => {
    expect(await processConnectorEvent(JSON.stringify({ entity_id: 'e1' }), {}, 'm2')).toBe('ack');
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('acks (skips) excluded conversational connector types', async () => {
    expect(await processConnectorEvent(connectorBody({ connector_type: 'slack' }), {}, 'm3')).toBe('ack');
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('acks without classification when harvestEligible=false', async () => {
    expect(await processConnectorEvent(connectorBody({ payload: { harvestEligible: false } }), {}, 'm4')).toBe('ack');
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('runs the pipeline and acks on success', async () => {
    expect(await processConnectorEvent(connectorBody({ payload: { data: { x: 1 } } }), {}, 'm5')).toBe('ack');
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  it('nacks when the pipeline throws', async () => {
    mockedRun.mockRejectedValueOnce(new Error('boom'));
    expect(await processConnectorEvent(connectorBody(), {}, 'm6')).toBe('nack');
  });
});

describe('processControlPlaneEvent', () => {
  beforeEach(() => mockedDelete.mockClear());

  it('acks (ignores) non connector.deleted events', async () => {
    expect(await processControlPlaneEvent({ eventType: 'something.else' })).toBe('ack');
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('acks (drops) connector.deleted missing ids', async () => {
    expect(await processControlPlaneEvent({ eventType: 'connector.deleted' })).toBe('ack');
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('cleans up and acks on a valid connector.deleted', async () => {
    expect(await processControlPlaneEvent({ eventType: 'connector.deleted', entityId: 'c1', tenantId: 't1' })).toBe('ack');
    expect(mockedDelete).toHaveBeenCalledWith('c1', 't1');
  });

  it('nacks when cleanup throws', async () => {
    mockedDelete.mockRejectedValueOnce(new Error('boom'));
    expect(await processControlPlaneEvent({ eventType: 'connector.deleted', entityId: 'c1', tenantId: 't1' })).toBe('nack');
  });
});

describe('decodePush', () => {
  it('returns null for a body that is not a Pub/Sub push envelope', () => {
    expect(decodePush({})).toBeNull();
    expect(decodePush(undefined)).toBeNull();
  });

  it('base64-decodes data and passes attributes + messageId', () => {
    const raw = connectorBody();
    const out = decodePush({
      message: { data: Buffer.from(raw).toString('base64'), attributes: { source: 'salesforce' }, messageId: 'abc' },
    });
    expect(out).toEqual({ data: raw, attributes: { source: 'salesforce' }, messageId: 'abc' });
  });
});
