// IntercomComposioClient — reactive Conversation polling via the Composio proxy.

const mockProxy = jest.fn();
const mockExecute = jest.fn();
jest.mock('../oauth/composio-client.js', () => ({
  composioProxyRequest: (...a: unknown[]) => mockProxy(...a),
  getComposio: () => ({ tools: { execute: mockExecute } }),
}));
jest.mock('../infra/logging.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { IntercomComposioClient } from './intercom-composio.js';

const client = new IntercomComposioClient({ tenantId: 'tenant-1', connectedAccountId: 'ca_abc' });

beforeEach(() => jest.clearAllMocks());

describe('IntercomComposioClient.list("Conversation")', () => {
  it('proxies GET /conversations and passes raw conversations through', async () => {
    // composioProxyRequest returns the raw Intercom response (no {successful,data} wrapper).
    mockProxy.mockResolvedValue({
      type: 'conversation.list',
      conversations: [
        { type: 'conversation', id: '101', updated_at: 2000, created_at: 1000, source: null, state: 'open' },
        { type: 'conversation', id: '102', updated_at: 3000, created_at: 1500, source: null, state: 'closed' },
      ],
    });

    const res = await client.list('Conversation', { since: new Date(0) });

    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({
      connectedAccountId: 'ca_abc',
      method: 'GET',
      endpoint: '/conversations',
      queryParams: { per_page: 150 },
    }));
    expect(res.hasMore).toBe(false);
    expect(res.records.map(r => r.id)).toEqual(['101', '102']);
    // source:null survives (the proxy doesn't choke where the action does); raw
    // shape passes through so IntercomNormalizer maps type:'conversation' → Conversation.
    expect(res.records[0].data).toMatchObject({ type: 'conversation', id: '101', source: null });
  });

  it('filters out conversations updated before the since watermark', async () => {
    mockProxy.mockResolvedValue({
      conversations: [
        { type: 'conversation', id: 'old', updated_at: 1000 },   // before since
        { type: 'conversation', id: 'new', updated_at: 5000 },   // after since
      ],
    });

    const res = await client.list('Conversation', { since: new Date(2000 * 1000) });
    expect(res.records.map(r => r.id)).toEqual(['new']);
  });

  it('throws when the Composio proxy fails', async () => {
    mockProxy.mockRejectedValue(new Error('Composio proxy GET /conversations: HTTP 503'));
    await expect(client.list('Conversation', { since: new Date(0) })).rejects.toThrow('HTTP 503');
  });
});
