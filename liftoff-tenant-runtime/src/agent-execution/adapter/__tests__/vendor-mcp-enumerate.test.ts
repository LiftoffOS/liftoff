// Vendor-hosted MCP enumeration. Verifies that a remote server's tools/list is
// mapped into catalog.tools with a NAMESPACED model-facing name + a BARE
// remoteToolName + classified categories, that probe failure degrades to [], and
// that the catalog merge dedups first-wins on the namespaced name (so a vendor
// `search` never collide-drops the in-process one).
//
// The transport layer (@liftoffos/runtime-mcp-transports via tool-gateway/transports)
// is mocked so no real vendor MCP server / HTTP is needed. The branch
// distinction (vendor-hosted OAuth Bearer vs custom_mcp custom headers) is
// upstream in resolveVendorMcpServers — both reduce to a RemoteMcpServerConfig
// with `headers`, so one helper test covers both branches.

jest.mock('../../../tool-gateway/transports', () => ({
  createTransportSync: jest.fn(),
}));

jest.mock('../vendor-mcp-tool-store', () => ({
  storeVendorToolList: jest.fn().mockResolvedValue(undefined),
  loadVendorToolList: jest.fn().mockResolvedValue(null),
}));

// The a priori seeds platform-backend serves per connector type. Empty by
// default so every existing case still exercises the heuristic path.
jest.mock('../../../clients/platform-backend-client', () => ({
  fetchToolClassifications: jest.fn().mockResolvedValue({ tools: [], operationKey: null }),
}));

import {
  enumerateVendorMcpTools,
  enumerateAndMergeVendorMcpTools,
  clearVendorMcpToolListCache,
  _clearSeededClassificationCache,
} from '../vendor-mcp-enumerate';
import { createTransportSync } from '../../../tool-gateway/transports';
import { logger } from '../../../infrastructure/logging';
import { storeVendorToolList, loadVendorToolList } from '../vendor-mcp-tool-store';
import { fetchToolClassifications } from '../../../clients/platform-backend-client';
import type { McpToolDefinition, RemoteMcpServerConfig } from '../catalog-types';

const mockCreate = createTransportSync as jest.Mock;

function makeProbe(
  toolsListResult: unknown,
  opts?: { connectThrows?: boolean; requestThrows?: boolean },
): { connect: jest.Mock; request: jest.Mock; close: jest.Mock } {
  return {
    connect: opts?.connectThrows
      ? jest.fn().mockRejectedValue(new Error('connect failed'))
      : jest.fn().mockResolvedValue(undefined),
    request: opts?.requestThrows
      ? jest.fn().mockRejectedValue(new Error('tools/list failed'))
      : jest.fn().mockResolvedValue(toolsListResult),
    close: jest.fn(),
  };
}

function makeRemoteServer(overrides: Partial<RemoteMcpServerConfig> = {}): RemoteMcpServerConfig {
  return {
    kind: 'remote',
    id: 'github-abc12345',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http',
    headers: { Authorization: 'Bearer gh_x' },
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  (storeVendorToolList as jest.Mock).mockClear().mockResolvedValue(undefined);
  (loadVendorToolList as jest.Mock).mockClear().mockResolvedValue(null);
  clearVendorMcpToolListCache();   // tool lists are cached by (url, headers) — isolate tests
  _clearSeededClassificationCache(); // seeds are cached by connector type — isolate tests
  (fetchToolClassifications as jest.Mock).mockClear().mockResolvedValue({ tools: [], operationKey: null });
});

// The seeds are the a priori classification of a vendor's public tool
// inventory, and they beat the name heuristics both ways: a seeded read is a
// read whatever its verb, and a seeded destructive tool is destructive however
// harmless its name reads. An unseeded tool takes the heuristic path unchanged.
describe('seeded classifications', () => {
  it('a seeded read beats an unknown-verb name', async () => {
    (fetchToolClassifications as jest.Mock).mockResolvedValue({
      tools: [{ name: 'materialize_report', categories: [] }],
      operationKey: null,
    });
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'materialize_report', description: 'Report' }] }));

    const [tool] = await enumerateVendorMcpTools(makeRemoteServer({ id: 'typefully-abc12345' }));
    // Looked up by the connector TYPE the server id carries, not the instance.
    expect(fetchToolClassifications).toHaveBeenCalledWith('typefully');
    // The heuristic sends an unknown verb to write; the seed says read.
    expect(tool.effect).toBe('read');
    expect(tool.categories).toEqual([]);
    expect(tool.description).toBe('Report');
  });

  it('a seeded destructive beats a read-looking name', async () => {
    (fetchToolClassifications as jest.Mock).mockResolvedValue({
      tools: [{ name: 'get_rid_of_draft', categories: ['write', 'destructive'] }],
      operationKey: null,
    });
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'get_rid_of_draft', description: 'Drop a draft' }] }));

    const [tool] = await enumerateVendorMcpTools(makeRemoteServer({ id: 'typefully-abc12345' }));
    expect(tool.effect).toBe('write');
    expect(tool.categories).toEqual(['write', 'destructive']);
    // The level-2 gate keys on the marker, so the seed must set it.
    expect(tool.description).toBe('⚠️ DESTRUCTIVE: Drop a draft');
  });

  it('an unseeded tool keeps the heuristic path and is logged as unseeded', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    (fetchToolClassifications as jest.Mock).mockResolvedValue({
      tools: [{ name: 'list_drafts', categories: [] }],
      operationKey: null,
    });
    mockCreate.mockReturnValue(makeProbe({
      tools: [{ name: 'list_drafts' }, { name: 'delete_draft', description: 'Delete a draft' }],
    }));

    const tools = await enumerateVendorMcpTools(makeRemoteServer({ id: 'typefully-abc12345' }));
    const del = tools.find((t) => t.remoteToolName === 'delete_draft')!;
    // Exactly what the heuristic path produced before seeds existed.
    expect(del.categories).toEqual(expect.arrayContaining(['destructive', 'dataChanges']));
    expect(del.description).toBe('⚠️ DESTRUCTIVE: Delete a draft');
    expect(del.effect).toBe('write');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ connectorType: 'typefully', tool: 'delete_draft', descriptionHash: expect.any(String) }),
      'vendor_mcp_tool_unseeded',
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'list_drafts' }),
      'vendor_mcp_tool_unseeded',
    );

    // A second enumeration of the same server does not repeat the line: one
    // per distinct (type, tool, description) per process is what a seed
    // completion needs, and one per invocation is a log storm.
    infoSpy.mockClear();
    clearVendorMcpToolListCache();
    mockCreate.mockReturnValue(makeProbe({
      tools: [{ name: 'list_drafts' }, { name: 'delete_draft', description: 'Delete a draft' }],
    }));
    await enumerateVendorMcpTools(makeRemoteServer({ id: 'typefully-abc12345' }));
    expect(infoSpy).not.toHaveBeenCalledWith(expect.anything(), 'vendor_mcp_tool_unseeded');
    infoSpy.mockRestore();
  });

  it('folds a meta-tool server\'s per-operation seeds onto the operation tool', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    (fetchToolClassifications as jest.Mock).mockResolvedValue({
      tools: [
        { name: 'search', categories: [] },
        { name: 'execute:get_automations', categories: [] },
        { name: 'execute:delete_campaigns_id', categories: ['write', 'destructive'] },
      ],
      operationKey: { tool: 'execute', arg: 'tool_name' },
    });
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'search' }, { name: 'execute', description: 'Run an operation' }] }));

    const tools = await enumerateVendorMcpTools(makeRemoteServer({ id: 'omnisend-abc12345' }));
    const execute = tools.find((t) => t.remoteToolName === 'execute')!;
    // The tool itself is the write class, fail closed; the gate reads the
    // operation off the call.
    expect(execute.effect).toBe('write');
    expect(execute.categories).toEqual([]);
    expect(execute.operationClassifications).toEqual({
      arg: 'tool_name',
      byOperation: { get_automations: [], delete_campaigns_id: ['write', 'destructive'] },
    });
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'execute' }),
      'vendor_mcp_tool_unseeded',
    );
    infoSpy.mockRestore();
  });

  // Migration 084 seeded github's delete_repository as ['dataChanges'] — no
  // write or destructive token, because the vocabulary did not exist yet. A
  // seed that cannot say "destructive" must not silence the marker the name
  // heuristic sets, or the level-2 gate stops firing on a repository delete.
  it('keeps the heuristic DESTRUCTIVE marker for a legacy-vocabulary seed', async () => {
    (fetchToolClassifications as jest.Mock).mockResolvedValue({
      tools: [
        { name: 'delete_repository', categories: ['dataChanges'] },
        { name: 'create_issue', categories: ['dataChanges'] },
        { name: 'get_issue', categories: [] },
      ],
      operationKey: null,
    });
    mockCreate.mockReturnValue(makeProbe({
      tools: [
        { name: 'delete_repository', description: 'Delete a repository' },
        { name: 'create_issue', description: 'Open an issue' },
        { name: 'get_issue', description: 'Read an issue' },
      ],
    }));

    const tools = await enumerateVendorMcpTools(makeRemoteServer({ id: 'github-abc12345' }));
    const del = tools.find((t) => t.remoteToolName === 'delete_repository')!;
    expect(del.effect).toBe('write');
    expect(del.description).toBe('⚠️ DESTRUCTIVE: Delete a repository');
    const create = tools.find((t) => t.remoteToolName === 'create_issue')!;
    expect(create.effect).toBe('write');
    expect(create.description).toBe('Open an issue');
    const get = tools.find((t) => t.remoteToolName === 'get_issue')!;
    expect(get.effect).toBe('read');
  });

  it('caches the seeds per connector type for the TTL', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'get_issue' }] }));
    await enumerateVendorMcpTools(makeRemoteServer({ id: 'github-aaaaaaaa' }));
    await enumerateVendorMcpTools(makeRemoteServer({ id: 'github-bbbbbbbb', url: 'https://other.example/mcp' }));
    expect(fetchToolClassifications).toHaveBeenCalledTimes(1);
  });
});

// A failed probe must not read as "this server has no tools". That equivalence
// is what let a GitHub 502 fail a workflow for naming a tool that exists, on a
// server the agent is bound to. See migration 377.
describe('when the vendor cannot be reached', () => {
  it('serves the list the server last answered with', async () => {
    (loadVendorToolList as jest.Mock).mockResolvedValue({
      tools: [{ name: 'pull_request_read' }],
      fetchedAt: new Date('2026-08-30T00:00:00Z'),
    });
    mockCreate.mockReturnValue(makeProbe({ tools: [] }, { connectThrows: true }));

    const tools = await enumerateVendorMcpTools(makeRemoteServer({ id: 'github-abc12345' }), { tenantId: 't1' });

    expect(tools.map((t) => t.name)).toEqual(['github-abc12345__pull_request_read']);
    // Namespaced for the model, bare on the wire — the stored entries go
    // through the same mapping the live ones do, not a second copy of it.
    expect(tools[0].remoteToolName).toBe('pull_request_read');
  });

  it('still degrades to [] when the server has never answered', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [] }, { connectThrows: true }));
    expect(await enumerateVendorMcpTools(makeRemoteServer(), { tenantId: 't1' })).toEqual([]);
  });

  it('does not consult the store without a tenant to scope it to', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [] }, { connectThrows: true }));
    expect(await enumerateVendorMcpTools(makeRemoteServer())).toEqual([]);
    expect(loadVendorToolList as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('when the vendor answers', () => {
  it('records the list, keyed by connector instance', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'get_issue' }] }));
    await enumerateVendorMcpTools(makeRemoteServer({ id: 'github-abc12345' }), { tenantId: 't1' });
    expect(storeVendorToolList as jest.Mock).toHaveBeenCalledWith(
      't1', 'github-abc12345', [{ name: 'get_issue' }],
    );
  });

  it('writes nothing when there is no tenant to key on', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'get_issue' }] }));
    await enumerateVendorMcpTools(makeRemoteServer());
    expect(storeVendorToolList as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('enumerateVendorMcpTools', () => {
  it('maps tools/list into namespaced name + bare remoteToolName + classified categories', async () => {
    mockCreate.mockReturnValue(makeProbe({
      tools: [
        { name: 'create_issue', description: 'Open an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
        { name: 'delete_repo', description: 'Delete a repository' },
        { name: 'get_issue', description: 'Read an issue' },
      ],
    }));

    const tools = await enumerateVendorMcpTools(makeRemoteServer());
    expect(tools).toHaveLength(3);

    const create = tools.find((t) => t.remoteToolName === 'create_issue')!;
    // Namespaced model-facing name (collision-safe), bare wire name preserved.
    expect(create.name).toBe('github-abc12345__create_issue');
    expect(create.remoteToolName).toBe('create_issue');
    expect(create.serverId).toBe('github-abc12345');
    expect(create.inputSchema).toEqual({ type: 'object', properties: { title: { type: 'string' } } });
    // 'create' → a non-destructive write → dataChanges (no destructive marker).
    expect(create.categories).toContain('dataChanges');
    expect(create.description).toBe('Open an issue');

    const del = tools.find((t) => t.remoteToolName === 'delete_repo')!;
    expect(del.name).toBe('github-abc12345__delete_repo');
    expect(del.categories).toEqual(expect.arrayContaining(['destructive', 'dataChanges']));
    // Destructive marker mirrors the in-process path so the level-2 gate sees it.
    expect(del.description).toBe('⚠️ DESTRUCTIVE: Delete a repository');

    // Read-only tool → no categories (conservative; never spuriously gates reads).
    const get = tools.find((t) => t.remoteToolName === 'get_issue')!;
    expect(get.categories).toEqual([]);
  });

  it('uses the bare name as remoteToolName so the wire tools/call matches the server', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'merge_pull_request' }] }));
    const [tool] = await enumerateVendorMcpTools(makeRemoteServer({ id: 'github-x' }));
    expect(tool.name).toBe('github-x__merge_pull_request');   // model-facing
    expect(tool.remoteToolName).toBe('merge_pull_request');    // on the wire
  });

  it('degrades to [] when the probe connect throws', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [] }, { connectThrows: true }));
    expect(await enumerateVendorMcpTools(makeRemoteServer())).toEqual([]);
  });

  it('degrades to [] when tools/list throws', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [] }, { requestThrows: true }));
    expect(await enumerateVendorMcpTools(makeRemoteServer())).toEqual([]);
  });

  it('degrades to [] when createTransportSync itself throws', async () => {
    mockCreate.mockImplementation(() => { throw new Error('bad transport'); });
    expect(await enumerateVendorMcpTools(makeRemoteServer())).toEqual([]);
  });

  it('selects the sse transport for sse servers', async () => {
    const probe = makeProbe({ tools: [] });
    mockCreate.mockReturnValue(probe);
    await enumerateVendorMcpTools(makeRemoteServer({ transport: 'sse' }));
    expect(mockCreate).toHaveBeenCalledWith('sse', expect.objectContaining({ authType: 'custom_headers' }));
  });

  it('follows nextCursor pagination and accumulates every page (no silent truncation)', async () => {
    const probe = {
      connect: jest.fn().mockResolvedValue(undefined),
      request: jest.fn()
        .mockResolvedValueOnce({ tools: [{ name: 'create_issue' }], nextCursor: 'p2' })
        .mockResolvedValueOnce({ tools: [{ name: 'delete_repo' }], nextCursor: 'p3' })
        .mockResolvedValueOnce({ tools: [{ name: 'get_issue' }] }),  // no nextCursor → stop
      close: jest.fn(),
    };
    mockCreate.mockReturnValue(probe);
    const tools = await enumerateVendorMcpTools(makeRemoteServer({ id: 'gh' }));
    expect(tools.map((t) => t.remoteToolName)).toEqual(['create_issue', 'delete_repo', 'get_issue']);
    // pages 2 and 3 carried the prior page's cursor.
    expect(probe.request).toHaveBeenNthCalledWith(1, 'tools/list', {});
    expect(probe.request).toHaveBeenNthCalledWith(2, 'tools/list', { cursor: 'p2' });
    expect(probe.request).toHaveBeenNthCalledWith(3, 'tools/list', { cursor: 'p3' });
  });

  it('caches the raw list by (url, headers) and maps per-server (different serverId reuses cache)', async () => {
    const probe = makeProbe({ tools: [{ name: 'create_issue' }] });
    mockCreate.mockReturnValue(probe);
    const a = await enumerateVendorMcpTools(makeRemoteServer({ id: 'server-a' }));
    const b = await enumerateVendorMcpTools(makeRemoteServer({ id: 'server-b' })); // same url+headers
    expect(mockCreate).toHaveBeenCalledTimes(1);     // transport created once (cache hit on 2nd)
    expect(probe.request).toHaveBeenCalledTimes(1);  // tools/list fetched once
    // ...but each server still namespaces with its OWN id (cache stores raw entries).
    expect(a[0].name).toBe('server-a__create_issue');
    expect(b[0].name).toBe('server-b__create_issue');
  });
});

describe('enumerateAndMergeVendorMcpTools', () => {
  const inProcess: McpToolDefinition[] = [
    { name: 'search', description: 'in-process search', inputSchema: {}, serverId: 'liftoff-tool-gateway' },
  ];

  it('keeps in-process tools and adds namespaced vendor tools (no collide-drop of a vendor `search`)', async () => {
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'search' }, { name: 'create_issue' }] }));
    const merged = await enumerateAndMergeVendorMcpTools(inProcess, [makeRemoteServer({ id: 'github-x' })]);
    const names = merged.map((t) => t.name).sort();
    // The in-process `search` and the vendor `search` both survive — the vendor
    // one is namespaced to `github-x__search`, so there is no collision.
    expect(names).toEqual(['github-x__create_issue', 'github-x__search', 'search']);
  });

  it('first-wins dedup on a true namespaced collision, logging the skip', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    // Contrived: an in-process tool already named exactly like the vendor's
    // namespaced name. First-wins keeps the in-process one; the vendor tool is
    // skipped + logged.
    const collidingInProcess: McpToolDefinition[] = [
      { name: 'github-x__create_issue', description: 'in-process', inputSchema: {}, serverId: 'liftoff-tool-gateway' },
    ];
    mockCreate.mockReturnValue(makeProbe({ tools: [{ name: 'create_issue' }] }));
    const merged = await enumerateAndMergeVendorMcpTools(collidingInProcess, [makeRemoteServer({ id: 'github-x' })]);
    const matching = merged.filter((t) => t.name === 'github-x__create_issue');
    expect(matching).toHaveLength(1);
    expect(matching[0].serverId).toBe('liftoff-tool-gateway');  // in-process won
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'github-x__create_issue', serverId: 'github-x' }),
      'vendor_mcp_tool_name_collision_skipped',
    );
    warnSpy.mockRestore();
  });

  it('degrades a failing vendor server to no tools without throwing (run proceeds with in-process only)', async () => {
    // A down vendor server must not break the invocation — this replaces the old
    // hard-fail (OpenAI eagerly connected native servers and threw on failure).
    mockCreate.mockReturnValue(makeProbe({ tools: [] }, { connectThrows: true }));
    const merged = await enumerateAndMergeVendorMcpTools(inProcess, [makeRemoteServer({ id: 'down' })]);
    expect(merged.map((t) => t.name)).toEqual(['search']);  // only the in-process tool; no throw
  });
});
