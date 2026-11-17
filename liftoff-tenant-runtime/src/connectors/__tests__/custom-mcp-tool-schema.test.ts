// The custom-MCP schema cache has a reader now.
//
// Its writer derives `idArgs` for every tool on a customer's own MCP server and
// says, in its own comment, that without this every vendor-hosted write falls
// to the heuristic floor. Nothing then read the map: the provenance gate looked
// declarations up by connector TYPE in the catalog map, and no catalog entry is
// keyed `custom_mcp`. The declarations sat one map over while every custom-MCP
// write was judged by the floor.
//
// The resolver is addressed the way a dispatch is: by the alias the engine sees
// (`custom-mcp-<first 8 of the uuid>`) and the bare tool name.

import {
  _seedCustomMcpServerSchemasForTesting,
  getCustomMcpToolSchema,
} from '../tool-schema-cache';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000000';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000000';

beforeEach(() => {
  _seedCustomMcpServerSchemasForTesting([
    {
      serverId: 'd144a7ea-91a0-4ce3-8e21-93a732a794e1',
      tenantId: TENANT_A,
      name: 'help-centre',
      functions: [
        { name: 'get_article', description: '', inputSchema: {}, categories: [], idArgs: ['slug'] } as never,
        { name: 'update_article', description: '', inputSchema: {}, categories: [], idArgs: ['slug'] } as never,
      ],
    },
    {
      // Same first eight hex characters as tenant A's server, on another
      // tenant. An eight-character prefix is not globally unique.
      serverId: 'd144a7ea-ffff-ffff-ffff-ffffffffffff',
      tenantId: TENANT_B,
      name: 'someone-elses',
      functions: [
        { name: 'update_article', description: '', inputSchema: {}, categories: [], idArgs: ['other_id'] } as never,
      ],
    },
  ]);
});

describe('getCustomMcpToolSchema', () => {
  it('resolves a tool by the alias the engine sees', () => {
    const fn = getCustomMcpToolSchema(TENANT_A, 'custom-mcp-d144a7ea', 'update_article');
    expect(fn?.idArgs).toEqual(['slug']);
  });

  it('is scoped to the tenant, so a shared prefix cannot hand over another tenant\'s declarations', () => {
    const fn = getCustomMcpToolSchema(TENANT_B, 'custom-mcp-d144a7ea', 'update_article');
    expect(fn?.idArgs).toEqual(['other_id']);
  });

  it('answers null for a tool the server does not have', () => {
    expect(getCustomMcpToolSchema(TENANT_A, 'custom-mcp-d144a7ea', 'delete_everything')).toBeNull();
  });

  it('answers null for anything that is not a custom-MCP alias', () => {
    // A catalog connector's alias resolves through the catalog map, not here;
    // answering for it would be a second lookup with a different answer.
    expect(getCustomMcpToolSchema(TENANT_A, 'google-mail-0105297e', 'create_draft')).toBeNull();
    expect(getCustomMcpToolSchema(TENANT_A, 'custom-mcp', 'update_article')).toBeNull();
  });
});
