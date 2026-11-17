// resolveActionReadClass — the runtime half of the provenance-aware read
// classification forwarded to the governance Authorize decision.

import { ActionReadClass } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb';

const getToolSchemasMock = jest.fn();
const getCustomMcpToolSchemaMock = jest.fn();
jest.mock('../../connectors/tool-schema-cache', () => ({
  // catalogTypeFor strips an instance-alias suffix (`pdl-1a2b3c4d` → `pdl`); the
  // real implementation is simple string work, mirrored here so the alias case
  // is actually exercised. A custom-MCP alias normalises to `custom_mcp`.
  catalogTypeFor: (c: string) => c.replace(/-[0-9a-f]{8}$/, '').replace(/-/g, '_'),
  CUSTOM_MCP_CATALOG_TYPE: 'custom_mcp',
  getToolSchemas: (t: string) => getToolSchemasMock(t),
  getCustomMcpToolSchema: (tenantId: string, alias: string, fn: string) => getCustomMcpToolSchemaMock(tenantId, alias, fn),
}));

import { resolveActionReadClass } from '../action-read-class';

const fn = (name: string, categories: string[], classificationDeclared?: boolean) => ({
  name, categories, classificationDeclared,
});

beforeEach(() => { getToolSchemasMock.mockReset(); getCustomMcpToolSchemaMock.mockReset(); });

describe('resolveActionReadClass', () => {
  it('DECLARED read → DECLARED_READ even when the name is not a read verb', () => {
    getToolSchemasMock.mockReturnValue([fn('enrich_company', ['read'], true)]);
    expect(resolveActionReadClass('t1', 'pdl', 'enrich_company')).toBe(ActionReadClass.DECLARED_READ);
  });

  it('DECLARED write/outbound → DECLARED_NON_READ (write signals win)', () => {
    getToolSchemasMock.mockReturnValue([fn('send_sms', ['outbound', 'read'], true)]);
    expect(resolveActionReadClass('t1', 'saperly', 'send_sms')).toBe(ActionReadClass.DECLARED_NON_READ);
  });

  it('INFERRED classification → UNSPECIFIED (engine keeps its fail-closed name heuristic)', () => {
    // Same shape as a declared read, but provenance is inferred — must NOT be trusted.
    getToolSchemasMock.mockReturnValue([fn('enrich_company', ['read'], false)]);
    expect(resolveActionReadClass('t1', 'pdl', 'enrich_company')).toBe(ActionReadClass.UNSPECIFIED);
  });

  it('unknown tool / empty cache → UNSPECIFIED', () => {
    getToolSchemasMock.mockReturnValue([]);
    expect(resolveActionReadClass('t1', 'pdl', 'enrich_company')).toBe(ActionReadClass.UNSPECIFIED);
  });

  it('normalises an instance alias to its catalog type before the lookup', () => {
    getToolSchemasMock.mockImplementation((t: string) =>
      t === 'pdl' ? [fn('enrich_company', ['read'], true)] : []);
    expect(resolveActionReadClass('t1', 'pdl-1a2b3c4d', 'enrich_company')).toBe(ActionReadClass.DECLARED_READ);
    expect(getToolSchemasMock).toHaveBeenCalledWith('pdl');
  });

  it('DECLARED but no positive read signal (empty categories) → DECLARED_NON_READ, not read', () => {
    getToolSchemasMock.mockReturnValue([fn('do_thing', [], true)]);
    expect(resolveActionReadClass('t1', 'x', 'do_thing')).toBe(ActionReadClass.DECLARED_NON_READ);
  });
});


describe('resolveActionReadClass — a customer\'s own MCP server (1b)', () => {
  it('looks the tool up by (tenantId, alias, fn) in the custom cache, never the connector catalog', () => {
    getCustomMcpToolSchemaMock.mockReturnValue(fn('enrich_company', ['read'], true));
    expect(resolveActionReadClass('t1', 'custom-mcp-d144a7ea', 'enrich_company')).toBe(ActionReadClass.DECLARED_READ);
    expect(getCustomMcpToolSchemaMock).toHaveBeenCalledWith('t1', 'custom-mcp-d144a7ea', 'enrich_company');
    expect(getToolSchemasMock).not.toHaveBeenCalled();
  });

  it('two tenants whose servers share the eight-character alias resolve to their own tools', () => {
    getCustomMcpToolSchemaMock.mockImplementation((tenantId: string) =>
      tenantId === 't1' ? fn('enrich_company', ['read'], true) : fn('enrich_company', ['destructive'], true));
    expect(resolveActionReadClass('t1', 'custom-mcp-d144a7ea', 'enrich_company')).toBe(ActionReadClass.DECLARED_READ);
    expect(resolveActionReadClass('t2', 'custom-mcp-d144a7ea', 'enrich_company')).toBe(ActionReadClass.DECLARED_NON_READ);
  });

  it('a read effect beside a sensitive category → DECLARED_NON_READ', () => {
    getCustomMcpToolSchemaMock.mockReturnValue(fn('get_invoice', ['datachanges', 'read'], true));
    expect(resolveActionReadClass('t1', 'custom-mcp-d144a7ea', 'get_invoice')).toBe(ActionReadClass.DECLARED_NON_READ);
  });

  it('unknown, or a tool with no effect class appended (not declared) → UNSPECIFIED', () => {
    getCustomMcpToolSchemaMock.mockReturnValue(null);
    expect(resolveActionReadClass('t1', 'custom-mcp-d144a7ea', 'nothing')).toBe(ActionReadClass.UNSPECIFIED);
    getCustomMcpToolSchemaMock.mockReturnValue(fn('enrich_company', [], undefined));
    expect(resolveActionReadClass('t1', 'custom-mcp-d144a7ea', 'enrich_company')).toBe(ActionReadClass.UNSPECIFIED);
  });
});
