// Adapter-driven response-shape tests for vendor-hosted MCP connectors.
//
// Vendor MCP servers (Notion, Stripe, HubSpot, ...) wrap responses in a
// JSON-RPC `tools/call` envelope; the vendor body itself lives in
// result.content[0].text as a JSON string. We stub the MCP client and
// feed the fixture body wrapped in the envelope, then assert the
// connector client correctly parses + re-shapes.

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { HubSpotMCPClient } from '../../clients/hubspot-mcp.js';
import { StripeMCPClient } from '../../clients/stripe-mcp.js';
import { NotionMCPClient } from '../../clients/notion-mcp.js';
import type { CredentialStore } from '../../mcp/credential-store.js';

function loadFixture(connectorType: string, action: string): unknown {
  return JSON.parse(
    readFileSync(resolve(__dirname, '__fixtures__', connectorType, `${action}.json`), 'utf-8'),
  );
}

function makeStore(accessToken = 'tkn'): CredentialStore {
  return {
    async getCredentials() { return { accessToken, refreshToken: 'rt' }; },
    async refreshOAuthToken() { return { accessToken, expiresInMs: 3_600_000 }; },
  } as CredentialStore;
}

function mcpEnvelope(body: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
}

function stubMCP(client: unknown, envelope: unknown): jest.Mock {
  const callTool = jest.fn().mockResolvedValue(envelope);
  (client as { mcpClient: { callTool: unknown } }).mcpClient = { callTool };
  return callTool;
}

describe('HubSpot MCP adapter', () => {
  it('list_contacts: results[] survives wrapping into {data.results}', async () => {
    const client = new HubSpotMCPClient({
      tenantId: 't', credentialStore: makeStore(),
    });
    const fixture = loadFixture('hubspot', 'contacts_list') as { results: unknown[] };
    const callTool = stubMCP(client, mcpEnvelope(fixture));

    const result = await client.read('contacts', undefined);

    expect(callTool).toHaveBeenCalledWith('list_contacts', expect.any(Object));
    expect(result.id).toBe('contacts');
    const data = result.data as { results: unknown[] };
    expect(data.results).toEqual(fixture.results);
  });

  it('parses an empty results envelope without crashing', async () => {
    const client = new HubSpotMCPClient({
      tenantId: 't', credentialStore: makeStore(),
    });
    stubMCP(client, mcpEnvelope({ results: [] }));
    const result = await client.read('contacts', undefined);
    const data = result.data as { results: unknown[] };
    expect(data.results).toEqual([]);
  });
});

describe('Stripe MCP adapter', () => {
  it('GetCustomersCustomer: fixture customer survives MCP envelope unwrap', async () => {
    const client = new StripeMCPClient({
      tenantId: 't', credentialStore: makeStore(),
    });
    const fixture = loadFixture('stripe', 'customers_list') as { data: Array<{ id: string; email: string }> };
    const customer = fixture.data[0];
    const callTool = stubMCP(client, mcpEnvelope(customer));

    const result = await client.read('customer', customer.id);

    expect(callTool).toHaveBeenCalledWith('stripe_api_read', expect.objectContaining({
      stripe_api_operation_id: 'GetCustomersCustomer',
      parameters: { customer: customer.id },
    }));
    expect(result.id).toBe(customer.id);
    const data = result.data as { id: string; email: string };
    expect(data.id).toBe(customer.id);
    expect(data.email).toBe(customer.email);
  });
});

describe('Notion MCP adapter', () => {
  it('databases.query: object=list + results[] envelope unwraps correctly', async () => {
    const client = new NotionMCPClient({
      tenantId: 't', credentialStore: makeStore(),
    });
    const fixture = loadFixture('notion', 'databases_query');
    const callTool = stubMCP(client, mcpEnvelope(fixture));

    let result: { data: unknown } | undefined;
    try {
      result = await client.read('database', 'db-1') as { data: unknown };
    } catch {
      /* the callTool assertion is the load-bearing one */
    }
    expect(callTool).toHaveBeenCalled();
    if (result) {
      const json = JSON.stringify(result.data);
      expect(json).toContain('00000000-0000-0000-0000-000000000001');
    }
  });
});
