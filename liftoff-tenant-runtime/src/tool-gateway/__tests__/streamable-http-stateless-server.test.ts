// The MCP spec lets a server assign a session id at initialize; it does not
// require one. A stateless server answers initialize without the header and
// expects none afterwards. The transport has to serve both kinds: Attio's
// server is stateless, CoinGecko's refuses a request without the id it gave.

import { StreamableHttpTransport } from '@liftoffos/runtime-mcp-transports';

type Call = { url: string; headers: Record<string, string>; body: { method: string } };

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function serverThat(assignsSessionId: string | null) {
  const calls: Call[] = [];
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { id?: number; method: string };
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    if (body.method === 'initialize') {
      return jsonResponse(
        { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } },
        assignsSessionId ? { 'mcp-session-id': assignsSessionId } : {},
      );
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'list_records' }] } });
  });
  return { calls, fetchMock };
}

function transport() {
  return new StreamableHttpTransport({
    config: { endpointUrl: 'https://mcp.example.test/mcp', authType: 'bearer_token', bearerToken: 't' },
  });
}

describe('StreamableHttpTransport and the session id', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('serves a stateless server: no session header is sent because none was given', async () => {
    const { calls, fetchMock } = serverThat(null);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await transport().request<{ tools: Array<{ name: string }> }>('tools/list', {});

    expect(result.tools.map((t) => t.name)).toEqual(['list_records']);
    const listCall = calls.find((c) => c.body.method === 'tools/list');
    expect(listCall).toBeDefined();
    expect(listCall!.headers['mcp-session-id']).toBeUndefined();
  });

  it('carries the session id a server assigned on every later request', async () => {
    const { calls, fetchMock } = serverThat('sess-42');
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await transport().request('tools/list', {});

    const initCall = calls.find((c) => c.body.method === 'initialize');
    expect(initCall!.headers['mcp-session-id']).toBeUndefined();
    for (const c of calls.filter((c) => c.body.method !== 'initialize')) {
      expect(c.headers['mcp-session-id']).toBe('sess-42');
    }
  });
});
