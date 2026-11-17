// An MCP tool result's `text` content is a STRING, not a JSON document.
//
// GenericMCPClient parsed it unconditionally, so any tool returning text died
// on the parse. GitHub's `pull_request_read` with `method: get_diff` returns a
// unified diff beginning `diff --git a/…`, so a reviewing agent could read a
// pull request successfully and then fail on the very next step fetching that
// PR's diff — one call short of the review it exists to write.
//
// The same block also had `isError` checked AFTER the parse, so an error result
// whose text is prose (which is what most servers send) threw a JSON syntax
// error and destroyed the real message on the way out. Every sibling client
// here — stripe-mcp, intercom-mcp, notion-mcp — already checks isError first.
//
// github is wired to this client: registerConnectorExecutor('github',
// genericMCPExecutor('github')) in clients/index.ts.

import { GenericMCPClient } from './generic-mcp.js';

const DIFF = 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';

function clientWithResult(result: unknown): GenericMCPClient {
  const client = new GenericMCPClient({
    tenantId: 'tenant-1',
    connectorType: 'github',
    mcpUrl: 'https://api.githubcopilot.com/mcp/',
    credentialStore: {} as never,
  });
  // Replace the transport; this test is about result interpretation only.
  (client as unknown as { mcpClient: { callTool: jest.Mock } }).mcpClient = {
    callTool: jest.fn().mockResolvedValue(result),
  } as never;
  return client;
}

describe('GenericMCPClient result interpretation', () => {
  it('returns a non-JSON text body verbatim instead of throwing', async () => {
    const client = clientWithResult({ content: [{ type: 'text', text: DIFF }] });
    const record = await client.read('pull_request_read', 'x');
    expect(record.data).toBe(DIFF);
  });

  it('still parses a JSON text body into an object', async () => {
    const client = clientWithResult({
      content: [{ type: 'text', text: '{"number":81,"title":"t"}' }],
    });
    const record = await client.read('pull_request_read', 'x');
    expect(record.data).toEqual({ number: 81, title: 't' });
  });

  it('surfaces an error result\'s PROSE message, not a JSON syntax error', async () => {
    // The ordering bug: parsing first replaced this message with
    // "Unexpected token 'N'…" and the caller never learned the cause.
    const client = clientWithResult({
      isError: true,
      content: [{ type: 'text', text: 'Not Found: pull request 999 does not exist' }],
    });
    await expect(client.read('pull_request_read', 'x')).rejects.toThrow(
      'Not Found: pull request 999 does not exist',
    );
  });

  it('surfaces an error result even when its text IS valid JSON', async () => {
    const client = clientWithResult({
      isError: true,
      content: [{ type: 'text', text: '{"message":"rate limited"}' }],
    });
    await expect(client.read('pull_request_read', 'x')).rejects.toThrow('rate limited');
  });

  it('returns an empty object when there is no text content at all', async () => {
    const client = clientWithResult({ content: [] });
    const record = await client.read('pull_request_read', 'x');
    expect(record.data).toEqual({});
  });
});
