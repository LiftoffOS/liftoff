// Hermetic tests for vendor MCP clients — Notion, HubSpot, Stripe,
// QuickBooks, Xero, Intercom. MCPClient is mocked so no network I/O
// happens; we only verify routing (right URL, right tool, right args).
//
// Port of tenant-runtime/src/connectors/clients/__tests__/vendor-mcp-clients.test.ts
// with connector-service module paths. The path-level differences: source
// reached for ../../infrastructure/mcp-client etc, we mock ../mcp/mcp-client.

const mockCallTool = jest.fn();
const mockListTools = jest.fn();
const mockDisconnect = jest.fn();
const mockSetCorrelationId = jest.fn();

jest.mock('../mcp/mcp-client.js', () => ({
  MCPClient: jest.fn().mockImplementation((config: { url: string }) => ({
    _url: config.url,
    callTool: mockCallTool,
    listTools: mockListTools,
    disconnect: mockDisconnect,
    setCorrelationId: mockSetCorrelationId,
  })),
}));

jest.mock('../mcp/token-provider.js', () => ({
  OAuthTokenProvider: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue('mock-token'),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { MCPClient as _MCPClientUnused } from '../mcp/mcp-client.js';
import { NotionMCPClient } from './notion-mcp.js';
import { HubSpotMCPClient } from './hubspot-mcp.js';
import { StripeMCPClient } from './stripe-mcp.js';
import { QuickBooksMCPClient } from './quickbooks-mcp.js';
import { XeroMCPClient } from './xero-mcp.js';
import { IntercomMCPClient } from './intercom-mcp.js';
import { ClayMCPClient } from './clay-mcp.js';
import { MeshMCPClient } from './mesh-mcp.js';
import { MCPClient } from '../mcp/mcp-client.js';

const MockMCPClient = MCPClient as unknown as jest.MockedClass<typeof MCPClient>;

function makeCredentialStore() {
  return {
    getCredentials: jest.fn().mockResolvedValue({ accessToken: 'mock-token' }),
    refreshOAuthToken: jest.fn(),
  };
}

function makeTextResult(data: Record<string, unknown>) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('NotionMCPClient', () => {
  it('constructs with the Notion MCP URL', () => {
    new NotionMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.notion.com/mcp' }),
    );
  });

  it('read(page) forwards id to the retrieve-a-page tool', async () => {
    mockCallTool.mockResolvedValue(
      makeTextResult({ id: 'p1', last_edited_time: '2026-01-01T00:00:00Z' }),
    );
    const client = new NotionMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    const res = await client.read('page', 'p1');
    expect(mockCallTool).toHaveBeenCalledWith('retrieve-a-page', { page_id: 'p1' });
    expect(res.id).toBe('p1');
  });
});

describe('HubSpotMCPClient', () => {
  it('constructs with the HubSpot MCP URL', () => {
    new HubSpotMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.hubspot.com' }),
    );
  });
});

describe('StripeMCPClient', () => {
  it('constructs with the Stripe MCP URL', () => {
    new StripeMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.stripe.com' }),
    );
  });
});

describe('QuickBooksMCPClient', () => {
  it('constructs with the Intuit MCP URL', () => {
    new QuickBooksMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.intuit.com' }),
    );
  });
});

describe('XeroMCPClient', () => {
  it('constructs with the Xero MCP URL', () => {
    new XeroMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.xero.com' }),
    );
  });
});

describe('IntercomMCPClient', () => {
  it('constructs with the Intercom MCP URL', () => {
    new IntercomMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.intercom.com' }),
    );
  });
});

describe('ClayMCPClient (Clay.com — connect-only until CLAY_FUNCTIONS)', () => {
  it('constructs with the Clay.com MCP URL', () => {
    new ClayMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.clay.com/v3/mcp' }),
    );
  });

  it('CRUD is unsupported until a CLAY_FUNCTIONS registry entry exists', async () => {
    const client = new ClayMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    await expect(client.read()).rejects.toThrow(/not registered/i);
    expect((await client.create()).error).toMatch(/not registered/i);
    expect((await client.delete()).error).toMatch(/not registered/i);
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

describe('MeshMCPClient (Mesh / mcp.clay.earth — personal relationship CRM)', () => {
  it('constructs with the Mesh MCP URL', () => {
    new MeshMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    expect(MockMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.clay.earth/mcp' }),
    );
  });

  it('read(contact) calls get_contact_by_id with the entityId', async () => {
    mockCallTool.mockResolvedValue(
      makeTextResult({ id: 'contact-1', name: 'Alice', updated_at: '2026-01-01T00:00:00Z' }),
    );
    const client = new MeshMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    const res = await client.read('contact', 'contact-1');
    expect(mockCallTool).toHaveBeenCalledWith('get_contact_by_id', { id: 'contact-1' });
    expect(res.id).toBe('contact-1');
    expect(res.lastModified).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('create(contact) calls add_contact and returns the new id', async () => {
    mockCallTool.mockResolvedValue(
      makeTextResult({ id: 'contact-new', name: 'Bob' }),
    );
    const client = new MeshMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    const res = await client.create('contact', { name: 'Bob', email: 'bob@example.com' });
    expect(mockCallTool).toHaveBeenCalledWith('add_contact', { name: 'Bob', email: 'bob@example.com' });
    expect(res.success).toBe(true);
    expect(res.id).toBe('contact-new');
  });

  it('delete returns a descriptive unsupported error', async () => {
    const client = new MeshMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    const res = await client.delete('contact', 'contact-1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/does not support delete/i);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('rejects unsupported entity types', async () => {
    const client = new MeshMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });
    await expect(client.read('invoice', 'inv-1')).rejects.toThrow(/Unsupported Mesh entity type/);
  });
});
