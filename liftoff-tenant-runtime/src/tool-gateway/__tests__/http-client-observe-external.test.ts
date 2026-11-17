// The client hears what the gateway says about a record.
//
// `ServiceClient.fetch` returns the Response, not its body. Read as if it were
// the body, `recorded` was never true: every record reported "not recorded",
// was retried three times and dropped with a metric, while the stream
// fallback quietly re-recorded it. The store worked; the client could not
// hear it say so. Seen on the first live run of the table-backed store, as 13
// `record_dropped` lines for 13 calls whose rows were all in the table.
//
// The dispatcher tests mock this client, so this drives the REAL one over a
// fake transport.

jest.mock('../../infrastructure/service-client-auth', () => ({
  withManagedServiceAuth: (_secret: string, options: Record<string, unknown>) => ({
    ...options,
    fetchImpl: (url: string, init?: RequestInit) => transport(url, init),
  }),
}));

let transport: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response('{}', { status: 200 });

import { ToolGatewayHttpClient } from '../http-client';

const args = {
  tenantId: 't', agentId: 'a', invocationId: 'inv', toolName: 'mcp__github-dd4c4689__pull_request_read',
  input: {}, result: { content: [] },
};

describe('observeExternal reads the gateway\'s answer', () => {
  const client = () => new ToolGatewayHttpClient({ baseUrl: 'http://tool-gateway.test' });

  it('is true when the gateway says the store took the record', async () => {
    transport = async () => new Response(JSON.stringify({ recorded: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(client().observeExternal(args)).resolves.toBe(true);
  });

  it('is false when the gateway says it did not', async () => {
    transport = async () => new Response(JSON.stringify({ recorded: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(client().observeExternal(args)).resolves.toBe(false);
  });

  it('throws on a transport failure, which the caller reads as "not recorded"', async () => {
    transport = async () => { throw new Error('connection refused'); };
    await expect(client().observeExternal(args)).rejects.toThrow();
  });
});
