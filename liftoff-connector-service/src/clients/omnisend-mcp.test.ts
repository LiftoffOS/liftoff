// Omnisend is a meta-tool server: tools/list names search / tool_schema /
// tool_documentation / execute, and the operations a picker needs live behind
// `execute`, enumerated by `search`. The generic client would answer
// `unsupported` for every entity because no tool in tools/list names one;
// this client runs the same discovery one level down.

import { OmnisendMCPClient, OMNISEND_META_TOOLS } from './omnisend-mcp.js';

const OPERATIONS = {
  tools: [
    { name: 'get_segments', method: 'GET', path: '/api/segments', description: 'List segments' },
    { name: 'get_segment_id', method: 'GET', path: '/api/segments/{segmentID}', description: 'Get segment' },
    { name: 'delete_segment_id', method: 'DELETE', path: '/api/segments/{segmentID}', description: 'Delete segment' },
    { name: 'get_campaigns', method: 'GET', path: '/api/campaigns', description: 'List campaigns' },
  ],
};

const SEGMENTS = { segments: [{ segmentID: 's1', name: 'VIPs' }, { segmentID: 's2', name: 'Lapsed' }] };

function text(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function clientWithTransport(callTool: jest.Mock): OmnisendMCPClient {
  const client = new OmnisendMCPClient({
    tenantId: 'tenant-1',
    mcpUrl: 'https://mcp.omnisend.com/mcp',
    credentialStore: {} as never,
  });
  // Replace the transport under the generic client; this test is about how
  // the operation is chosen and invoked, not the wire.
  (client as unknown as { generic: { mcpClient: unknown } }).generic = Object.assign(
    (client as unknown as { generic: object }).generic,
    { mcpClient: { callTool } },
  );
  return client;
}

describe('OmnisendMCPClient.list', () => {
  it('discovers the operation behind execute and runs it', async () => {
    const callTool = jest.fn()
      .mockResolvedValueOnce(text(OPERATIONS))   // search
      .mockResolvedValueOnce(text(SEGMENTS));    // execute
    const client = clientWithTransport(callTool);

    const result = await client.list('segments');

    expect(callTool).toHaveBeenNthCalledWith(1, OMNISEND_META_TOOLS.searchTool, {});
    expect(callTool).toHaveBeenNthCalledWith(2, OMNISEND_META_TOOLS.executeTool, {
      [OMNISEND_META_TOOLS.operationArg]: 'get_segments',
      [OMNISEND_META_TOOLS.payloadArg]: {},
    });
    expect(result.unsupported).toBeUndefined();
    expect(result.records.map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('never picks a single-record read or a delete as the enumerator', async () => {
    const callTool = jest.fn()
      .mockResolvedValueOnce(text({ tools: OPERATIONS.tools.filter((t) => t.name !== 'get_segments') }))
      .mockResolvedValueOnce(text({}));
    const client = clientWithTransport(callTool);

    const result = await client.list('segments');

    // get_segment_id needs an id we do not have and delete_segment_id is not
    // a read at all; with no enumerator the honest answer is unsupported.
    expect(result.unsupported).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('says unsupported, not empty, for an entity no operation enumerates', async () => {
    const callTool = jest.fn().mockResolvedValueOnce(text(OPERATIONS));
    const client = clientWithTransport(callTool);

    const result = await client.list('webhooks');

    expect(result).toEqual({ records: [], hasMore: false, unsupported: true });
  });

  it('names the operation with the same argument the HITL seed resolves on', () => {
    // The seed rows are keyed `execute:<operation>` and the runtime reads the
    // operation off this argument; the two must not drift.
    expect(OMNISEND_META_TOOLS.operationArg).toBe('tool_name');
  });
});
