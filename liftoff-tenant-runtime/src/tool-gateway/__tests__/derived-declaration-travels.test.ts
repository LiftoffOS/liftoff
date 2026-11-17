// The judge learns a vendor-hosted tool from the request, not from a memory.
//
// A vendor-hosted server is enumerated in the agent service and never reaches
// the gateway's caches. A first design had the run REGISTER what it found and
// the gateway keep it in a process-local map — the same scale-out defect the
// provenance store had just left behind: a registration on instance A is not
// on instance B, and B's guard answers `no_declaration` and fails open. The
// reviewer reproduced it with two module instances; so does this, inverted:
// two gateway instances over one table, nothing registered anywhere, and the
// declaration arriving with each request.
//
// And a derived declaration holds like a written one. It used to be
// provisional — judged, reported, never held — until the rule it is derived
// by (derive-declarations.ts) had been read against the whole catalog; a rule
// reviewed on the estate vouches for the tools it is applied to. What the
// rule cannot see costs the run one read, which the hold names.

jest.mock('../../connectors/connector-service-client', () => ({ getConnectorServiceClient: () => ({}) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../state-fetcher', () => ({ stateFetcherRegistry: { fetchState: jest.fn() } }));
jest.mock('../permission-validator', () => ({ permissionValidator: { validate: jest.fn() } }));
jest.mock('../conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { ToolGatewayService } from '../service';
import { PostgresProvenanceStore, type ScopedQuery, _setProvenanceStoreForTesting } from '../provenance-store';
import { logger } from '../../infrastructure/logging';
import { sdkCallNameFor } from '../../hitl-enforcement/tool-name-resolution';
import { derivedDeclarationFor } from '../../agent-execution/remember-external-tool-call';

/** One table shared by every store instance handed it. */
function fakeTable(): ScopedQuery {
  const rows: Array<Record<string, unknown>> = [];
  let clock = 0;
  return async (tenantId, text, params) => {
    if (/^INSERT/i.test(text.trim())) {
      const [tenant, invocation, ...rest] = params as [string, string, ...unknown[]];
      for (let i = 0; i + 3 < rest.length; i += 4) {
        const [kind, entityType, value] = rest.slice(i, i + 3) as [string, string, string];
        const dup = rows.some((r) => r.tenant_id === tenant && r.invocation_id === invocation && r.kind === kind && r.entity_type === entityType && r.value === value);
        if (!dup) rows.push({ tenant_id: tenant, invocation_id: invocation, kind, entity_type: entityType, value, created_at: clock++ });
      }
      return { rows: [] };
    }
    if (/SELECT kind, entity_type, value, created_at/.test(text)) {
      const mine = rows.filter((r) => r.invocation_id === params[0] && r.tenant_id === tenantId);
      return { rows: mine.sort((a, b) => (a.created_at as number) - (b.created_at as number)) };
    }
    return { rows: [] };
  };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const NOTION_PAGE_SCHEMA = { type: 'object', properties: { page_id: { type: 'string' }, title: { type: 'string' } }, required: ['page_id'] };
const emitted = (spy: jest.SpyInstance, event: string) =>
  spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((p) => p && p.event === event);

const env = { ...process.env };
let warn: jest.SpyInstance;
let info: jest.SpyInstance;
beforeEach(() => {
  process.env = { ...env };
  delete process.env.PROVENANCE_GATE_MODE;
  delete process.env.PROVENANCE_ENFORCE_CONNECTORS;
  warn = jest.spyOn(logger, 'warn');
  info = jest.spyOn(logger, 'info');
  warn.mockClear(); info.mockClear();
});
afterEach(() => _setProvenanceStoreForTesting(undefined));

describe('the declaration arrives with the request', () => {
  it('is judged on the instance that never saw the server, with nothing registered', async () => {
    const table = fakeTable();
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(table));
    const a = new ToolGatewayService();
    const b = new ToolGatewayService();
    const inv = 'inv-two-instances';
    // A read on instance A: the floor records the page id it returned.
    await a.observeExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__search_pages', input: { query: 'roadmap' },
      result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'page-aaaa-1111' }] }) }] },
    });
    // A write on instance B, carrying what the caller derived from the tool's
    // own schema. B has no map to consult and needs none.
    const grounded = await b.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__update_page', input: { page_id: 'page-aaaa-1111', title: 'x' },
      derived: { idArgs: ['page_id'] },
    });
    expect(grounded).toBeNull();
    const [pass] = emitted(info, 'provenance_pass');
    expect(pass).toEqual(expect.objectContaining({ basis: 'declared_id_args', actionType: 'update_page' }));

    const ungrounded = await b.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__update_page', input: { page_id: 'page-never-read-9', title: 'x' },
      derived: { idArgs: ['page_id'] },
    });
    // Shadow mode: reported, not held.
    expect(ungrounded).toBeNull();
    const [block] = emitted(warn, 'provenance_would_block');
    expect(block).toEqual(expect.objectContaining({ basis: 'declared_id_args', unseen: ['page-never-read-9'] }));
  });

  it('is not judged at all when the request carries nothing and nobody declared the tool', async () => {
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(fakeTable()));
    const b = new ToolGatewayService();
    await b.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: 'inv-bare',
      toolName: 'mcp__notion-0badf00d__update_page', input: { page_id: 'page-never-read-9' },
    });
    expect(emitted(info, 'provenance_not_judged')).toHaveLength(1);
  });
});

describe('a derived declaration holds like a written one', () => {
  it('holds the ungrounded write under enforce, and names the read to run', async () => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'notion';
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(fakeTable()));
    const svc = new ToolGatewayService();
    const inv = 'inv-derived';
    await svc.observeExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__search_pages', input: {},
      result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'page-aaaa-1111' }] }) }] },
    });
    const hold = await svc.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__update_page', input: { page_id: 'page-never-read-9' },
      derived: { idArgs: ['page_id'] },
    });
    expect(hold).toMatch(/^Held: notion\.update_page names page-never-read-9/);
    expect(emitted(warn, 'provenance_would_block')).toEqual([expect.objectContaining({ basis: 'declared_id_args', mode: 'enforce' })]);

    // The same write, naming what the run read, goes through.
    const grounded = await svc.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__update_page', input: { page_id: 'page-aaaa-1111' },
      derived: { idArgs: ['page_id'] },
    });
    expect(grounded).toBeNull();
  });

  it("holds under `declared` with no connector named, and never holds a write nothing declares", async () => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'declared';
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(fakeTable()));
    const svc = new ToolGatewayService();
    const inv = 'inv-declared';
    // A run that has read nothing is not judged at all; this one has read.
    await svc.observeExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__search_pages', input: {},
      result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'page-aaaa-1111' }] }) }] },
    });
    const held = await svc.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__update_page', input: { page_id: 'page-never-read-9' },
      derived: { idArgs: ['page_id'] },
    });
    expect(held).toMatch(/^Held: notion\.update_page/);
    // No declaration in hand: the floor reports, the floor does not refuse.
    const undeclared = await svc.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__notion-0badf00d__update_page', input: { page_id: 'page-never-read-9' },
    });
    expect(undeclared).toBeNull();
    expect(emitted(info, 'provenance_not_judged')).toHaveLength(1);
  });

  it('holds on the hand-written declaration for the same connector under the same settings', async () => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github';
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(fakeTable()));
    const svc = new ToolGatewayService();
    const inv = 'inv-declared';
    await svc.observeExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__github-dd4c4689__pull_request_read', input: { method: 'get', owner: 'acme', repo: 'r', pullNumber: 123 },
      result: { content: [{ type: 'text', text: JSON.stringify({ number: 123, base: { repo: { full_name: 'acme/r' } }, head: { sha: 'abc' } }) }] },
    });
    const hold = await svc.guardExternal({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__github-dd4c4689__pull_request_review_write', input: { owner: 'acme', repo: 'r', pullNumber: 124, body: 'x' },
      // A derived declaration sent alongside changes nothing: the hand-written
      // one is what the judge reads for a declared operation.
      derived: { idArgs: ['pullNumber'] },
    });
    expect(hold).toMatch(/Held: github\.pull_request_review_write names github:acme\/r#124/);
    expect(emitted(warn, 'provenance_would_block')).toHaveLength(1);
  });
});

describe('the caller derives from the tool it resolved', () => {
  const catalog = {
    tools: [{ name: 'call_notion_0badf00d_tool', serverId: 'notion-0badf00d', inputSchema: {} }],
    deferredVendorTools: new Map([[
      'notion-0badf00d',
      [{ name: 'notion-0badf00d__update_page', remoteToolName: 'update_page', serverId: 'notion-0badf00d', inputSchema: NOTION_PAGE_SCHEMA }],
    ]]),
  };

  it('finds the schema through the collapsed wrapper and through the bare name', () => {
    const wrapped = sdkCallNameFor(catalog, 'call_notion_0badf00d_tool', { name: 'update_page', args: { page_id: 'p' } });
    expect(wrapped).toEqual({ toolName: 'mcp__notion-0badf00d__update_page', args: { page_id: 'p' }, inputSchema: NOTION_PAGE_SCHEMA });
    const bare = sdkCallNameFor(catalog, 'notion-0badf00d__update_page', { page_id: 'p' });
    expect(bare.inputSchema).toEqual(NOTION_PAGE_SCHEMA);
    expect(derivedDeclarationFor(wrapped.inputSchema, wrapped.toolName)).toEqual({ derived: { idArgs: ['page_id'] } });
  });

  it('sends nothing for a tool with no schema in hand, or none that names a record', () => {
    expect(derivedDeclarationFor(undefined)).toEqual({});
    expect(derivedDeclarationFor({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] })).toEqual({});
  });
});
