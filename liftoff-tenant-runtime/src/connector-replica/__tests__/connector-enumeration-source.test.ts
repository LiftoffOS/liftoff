// Turning a connector's list functions into census pages.
//
// The properties that matter are about what this must NOT do: never fetch a
// body, never conclude a partial page is the whole scope, and never turn a
// quota refusal into a job failure.

const mockGetToolSchemas = jest.fn();
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: (...a: unknown[]) => mockGetToolSchemas(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  buildConnectorEnumerationSource,
  enumerableFunctions,
} from '../connector-enumeration-source';
import { EnumerationRateLimited } from '../enumerate-worker';

const mockExecute = jest.fn();
const gateway = { execute: mockExecute } as never;

const fn = (name: string, entityType?: string) => ({
  name,
  description: '',
  inputSchema: { type: 'object' as const, properties: {} },
  categories: ['read'],
  ...(entityType ? { entityType } : {}),
});

const source = () => buildConnectorEnumerationSource({
  toolGateway: gateway,
  agentId: 'census',
  instructionVersion: 0,
  traceId: 'trace-1',
});

const args = {
  tenantId: 't1',
  connectorId: 'c1',
  connectorType: 'slack',
  scope: 'list_channels',
  cursor: null as string | null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetToolSchemas.mockReturnValue([
    fn('list_channels', 'channel'),
    fn('get_channel'),
    fn('send_message'),
    fn('search_messages'),
  ]);
});

describe('which functions enumerate', () => {
  it('picks list / search / query functions only', () => {
    expect(enumerableFunctions('slack').map((f) => f.name)).toEqual(['list_channels', 'search_messages']);
  });

  it('never picks a per-entity read — that is what turns a census into a crawl', () => {
    expect(enumerableFunctions('slack').map((f) => f.name)).not.toContain('get_channel');
  });

  it('never picks a write', () => {
    expect(enumerableFunctions('slack').map((f) => f.name)).not.toContain('send_message');
  });

  it('returns nothing rather than throwing when the schema cache fails', () => {
    mockGetToolSchemas.mockImplementation(() => { throw new Error('cache cold'); });
    expect(enumerableFunctions('slack')).toEqual([]);
  });
});

describe('mapping a page', () => {
  it('extracts identifiers, titles and versions from a vendor row', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      data: { items: [{ id: 'C1', name: 'engineering', updated_at: '2026-08-01' }] },
    });
    const batch = await source()(args);
    expect(batch.entities).toEqual([{
      remoteId: 'C1',
      entityType: 'channel',
      title: 'engineering',
      projectedPath: 'slack/channel/C1',
      parentRemoteId: null,
      remoteVersion: '2026-08-01',
    }]);
  });

  it('drops a row with no identifier rather than inventing one', async () => {
    mockExecute.mockResolvedValue({ success: true, data: { items: [{ description: 'nameless' }] } });
    const batch = await source()(args);
    expect(batch.entities).toEqual([]);
  });

  it('reads rows out of whichever array the connector used', async () => {
    for (const key of ['items', 'results', 'records', 'channels']) {
      mockExecute.mockResolvedValue({ success: true, data: { [key]: [{ id: 'X' }] } });
      const batch = await source()(args);
      expect(batch.entities).toHaveLength(1);
    }
  });

  it('produces a stable path so re-enumeration updates rather than duplicates', async () => {
    mockExecute.mockResolvedValue({ success: true, data: { items: [{ id: 'a/b c' }] } });
    const first = await source()(args);
    const second = await source()(args);
    expect(first.entities[0].projectedPath).toBe(second.entities[0].projectedPath);
    expect(first.entities[0].projectedPath).toBe('slack/channel/a-b-c');
  });
});

describe('completeness', () => {
  it('marks a final page COMPLETE, so deletion detection may run', async () => {
    mockExecute.mockResolvedValue({ success: true, data: { items: [{ id: 'C1' }] } });
    expect((await source()(args)).kind).toBe('complete');
  });

  it('marks a page with more to come INCREMENTAL', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      data: { items: [{ id: 'C1' }], nextPageToken: 'p2' },
    });
    const batch = await source()(args);
    expect(batch.kind).toBe('incremental');
    expect(batch.cursor).toBe('p2');
  });

  it('reports INCREMENTAL when the function no longer exists', async () => {
    // A connector that stopped declaring a function must not cause everything
    // it used to enumerate to be marked deleted.
    mockGetToolSchemas.mockReturnValue([]);
    const batch = await source()(args);
    expect(batch.kind).toBe('incremental');
    expect(batch.entities).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('quota refusals', () => {
  it('translates a thrown rate-limit into a park signal', async () => {
    mockExecute.mockRejectedValue(Object.assign(new Error('quota'), {
      code: 'rate_limited', retryAfterMs: 45_000,
    }));
    await expect(source()(args)).rejects.toBeInstanceOf(EnumerationRateLimited);
  });

  it('translates an in-band rate-limit result into a park signal', async () => {
    mockExecute.mockResolvedValue({
      success: false, error: 'slow down', errorCode: 'rate_limited', retryAfterMs: 30_000,
    });
    await expect(source()(args)).rejects.toBeInstanceOf(EnumerationRateLimited);
  });

  it('lets a genuine failure through as a failure', async () => {
    mockExecute.mockResolvedValue({ success: false, error: 'not authorized' });
    await expect(source()(args)).rejects.toThrow('not authorized');
  });
});

describe('the dispatch itself', () => {
  it('calls the connector function through the gateway with no HITL pause', async () => {
    mockExecute.mockResolvedValue({ success: true, data: { items: [] } });
    await source()(args);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      connector: 'c1',
      actionType: 'list_channels',
      entityType: 'channel',
      _internalSkipHitl: true,
    }));
  });

  it('forwards the cursor so a resumed job does not start over', async () => {
    mockExecute.mockResolvedValue({ success: true, data: { items: [] } });
    await source()({ ...args, cursor: 'p2' });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      payload: { cursor: 'p2', pageToken: 'p2' },
    }));
  });
});
