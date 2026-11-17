// Collapsing an oversized tool group behind a search pair.
//
// The case that justifies this: a SINGLE vendor MCP server can supply dozens
// of one agent's tools, every schema paid on every model call whether the
// server is touched or not. The sandbox catalog is the second half
// and the larger one — 90 tools for every execution_enabled agent.
//
// The two things that must not break: a normal-sized group is left completely
// alone, and a tool the agent's own instructions NAME is never collapsed —
// deferring `file_read` or `shell_exec` breaks the prompt's own vocabulary.

import {
  DEFAULT_SERVER_TOOL_CAP,
  applyToolTiering,
  vendorServerGroups,
  sandboxGroups,
  NEVER_COLLAPSE_SANDBOX_TOOLS,
  parseTieredToolName,
  searchDeferredTools,
} from '../tool-tiering';
import type { McpToolDefinition } from '../catalog-types';

function tool(name: string, serverId: string, description = ''): McpToolDefinition {
  return { name, description, inputSchema: {}, serverId } as McpToolDefinition;
}

function vendorTools(serverId: string, n: number): McpToolDefinition[] {
  return Array.from({ length: n }, (_, i) => tool(`${serverId}__op_${i}`, serverId, `Operation ${i}`));
}

const isVendor = (t: McpToolDefinition) => t.serverId.startsWith('vendor-');

/** One auto-derived group per vendor server — the shape the old
 *  `isVendorTool` predicate expanded to, byte for byte. */
const vendorGroups = (tools: McpToolDefinition[], cap?: number) =>
  vendorServerGroups(tools, isVendor, cap);

function sandboxTool(name: string, description = ''): McpToolDefinition {
  return { name, description, inputSchema: {}, serverId: 'liftoff-tool-gateway', source: 'sandbox' } as McpToolDefinition;
}

describe('the cap', () => {
  it('is above a well-behaved integration and below the case that prompted this', () => {
    expect(DEFAULT_SERVER_TOOL_CAP).toBeGreaterThan(10);
    expect(DEFAULT_SERVER_TOOL_CAP).toBeLessThan(44);
  });
});

describe('a server under the cap', () => {
  it('is left exactly as it was', () => {
    const tools = [...vendorTools('vendor-a', 5), tool('memory_save', 'liftoff-tool-gateway')];
    const r = applyToolTiering(tools, vendorGroups(tools));
    expect(r.tools).toEqual(tools);
    expect(r.collapsedServers).toEqual([]);
    expect(r.deferred.size).toBe(0);
  });
});

describe('a server over the cap', () => {
  const tools = [
    ...vendorTools('vendor-big', 44),
    tool('memory_save', 'liftoff-tool-gateway'),
    tool('file_write', 'liftoff-tool-gateway'),
    tool('propose_routine', 'liftoff-tool-gateway'),
    tool('run_routine_now', 'liftoff-tool-gateway'),
    ...vendorTools('vendor-small', 3),
  ];
  const r = applyToolTiering(tools, vendorGroups(tools));

  it('contributes two tools instead of forty-four', () => {
    const fromBig = r.tools.filter((t) => t.serverId === 'vendor-big');
    expect(fromBig).toHaveLength(2);
    expect(fromBig.map((t) => t.name).sort()).toEqual(
      ['call_vendor_big_tool', 'search_vendor_big_tools'],
    );
  });

  it('keeps every deferred tool resolvable', () => {
    expect(r.deferred.get('vendor-big')).toHaveLength(44);
  });

  it('leaves the small vendor server alone', () => {
    expect(r.tools.filter((t) => t.serverId === 'vendor-small')).toHaveLength(3);
  });

  it('never collapses platform tools', () => {
    // These are what the agent's own instructions name.
    const names = r.tools.map((t) => t.name);
    expect(names).toContain('memory_save');
    expect(names).toContain('file_write');
    // The routine rails the chat prompt names by name. On the engines that
    // consume catalog.tools (OpenAI, Google, xAI, OpenRouter) THIS pass-
    // through is what keeps them visible without a search, the way alwaysLoad
    // does on the Claude Agent SDK. Whatever the provider, the prompt's
    // named tools are in front of the model.
    expect(names).toContain('propose_routine');
    expect(names).toContain('run_routine_now');
  });

  it('shrinks the catalog', () => {
    expect(r.tools.length).toBeLessThan(tools.length);
  });

  it('tells the model how many tools are behind the search', () => {
    const search = r.tools.find((t) => t.name === 'search_vendor_big_tools');
    expect(search?.description).toContain('44');
  });

  it('a deferred tool keeps what it DOES: the gate and the message check read it out of this list', () => {
    const outbound: McpToolDefinition = {
      name: 'vendor-big__add_issue_comment',
      description: 'Comment on an issue',
      inputSchema: {},
      serverId: 'vendor-big',
      remoteToolName: 'add_issue_comment',
      categories: ['dataChanges', 'externalPublishing'],
      effect: 'write',
      draftVariant: 'draft_issue_comment',
      writeRole: 'direct',
    };
    const withOutbound = [...vendorTools('vendor-big', 44), outbound];
    const tiered = applyToolTiering(withOutbound, vendorGroups(withOutbound));
    const deferred = tiered.deferred.get('vendor-big')?.find((t) => t.name === outbound.name);
    expect(deferred).toMatchObject({
      remoteToolName: 'add_issue_comment',
      categories: ['dataChanges', 'externalPublishing'],
      effect: 'write',
      draftVariant: 'draft_issue_comment',
      writeRole: 'direct',
    });
  });
});

describe('turning tiering off', () => {
  it('a non-positive cap disables it entirely', () => {
    const tools = vendorTools('vendor-big', 44);
    expect(applyToolTiering(tools, vendorGroups(tools), 0).tools).toEqual(tools);
  });
});

describe('parseTieredToolName', () => {
  it('recognises both halves of the pair', () => {
    expect(parseTieredToolName('search_vendor_big_tools')).toEqual({ kind: 'search', serverKey: 'vendor_big' });
    expect(parseTieredToolName('call_vendor_big_tool')).toEqual({ kind: 'call', serverKey: 'vendor_big' });
  });

  it('ignores an ordinary tool', () => {
    expect(parseTieredToolName('memory_save')).toBeNull();
    expect(parseTieredToolName('github__create_issue')).toBeNull();
  });
});

describe('searchDeferredTools', () => {
  const candidates = [
    { name: 'gh__create_issue', description: 'Open a new issue', inputSchema: {}, serverId: 'v' },
    { name: 'gh__list_pulls', description: 'List pull requests', inputSchema: {}, serverId: 'v' },
    { name: 'gh__merge_pull', description: 'Merge a pull request', inputSchema: {}, serverId: 'v' },
  ];

  it('finds by description', () => {
    const r = searchDeferredTools(candidates, 'merge a pull request');
    expect(r[0].name).toBe('gh__merge_pull');
  });

  it('weights a name match above a description match', () => {
    // The model is usually reaching for something it half-remembers the name of.
    const r = searchDeferredTools(candidates, 'issue');
    expect(r[0].name).toBe('gh__create_issue');
  });

  it('returns nothing rather than noise when nothing matches', () => {
    expect(searchDeferredTools(candidates, 'quarterly revenue forecast')).toEqual([]);
  });

  it('falls back to a listing when the query is empty', () => {
    expect(searchDeferredTools(candidates, '').length).toBe(3);
  });

  it('returns the input schema, so the model can call what it found', () => {
    const r = searchDeferredTools(candidates, 'issue');
    expect(r[0]).toHaveProperty('inputSchema');
  });

  it('is bounded', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `t_${i}`, description: 'issue thing', inputSchema: {}, serverId: 'v',
    }));
    expect(searchDeferredTools(many, 'issue').length).toBeLessThanOrEqual(8);
  });
});


// ── The sandbox half ────────────────────────────────────────────────────────
describe('sandbox groups', () => {
  // 43 browser tools reach every execution_enabled agent, on every model call,
  // whether or not the agent has anything to do with a browser.
  const browser = Array.from({ length: 43 }, (_, i) => sandboxTool(`browser_op_${i}`, `Browser operation ${i}`));
  const named = [...NEVER_COLLAPSE_SANDBOX_TOOLS].map((n) => sandboxTool(n));
  const tools = [...browser, ...named];
  const r = applyToolTiering(tools, sandboxGroups());

  it('collapses the browser family behind one pair', () => {
    const names = r.tools.map((t) => t.name);
    expect(names).toContain('search_sandbox_browser_tools');
    expect(names).toContain('call_sandbox_browser_tool');
    expect(names.filter((n) => n.startsWith('browser_'))).toEqual([]);
  });

  // The list exists because distilled prompts and skills name these by
  // vocabulary. An agent told to "read the file, then run the tests" cannot
  // follow that if file_read and shell_exec have to be searched for first.
  it('never collapses a tool the prompts name', () => {
    const names = new Set(r.tools.map((t) => t.name));
    for (const kept of NEVER_COLLAPSE_SANDBOX_TOOLS) {
      expect(names.has(kept)).toBe(true);
    }
  });

  // code_session is tagged source:'sandbox' but is NOT in function-registry.ts —
  // it is pushed separately — so a naive source-based predicate would collapse
  // the primary code-work entry point on the Anthropic path.
  it('never collapses code_session', () => {
    expect(r.tools.map((t) => t.name)).toContain('code_session');
  });

  it('shrinks the catalog substantially', () => {
    expect(r.tools.length).toBeLessThan(tools.length / 2);
  });

  it('leaves a non-sandbox tool of the same name shape alone', () => {
    const connectorBrowserTool = { name: 'browser_fetch', description: '', inputSchema: {}, serverId: 'connector-x', source: 'connector' } as McpToolDefinition;
    const mixed = [...browser, connectorBrowserTool];
    const out = applyToolTiering(mixed, sandboxGroups());
    expect(out.tools.map((t) => t.name)).toContain('browser_fetch');
  });

  // Collapsing a single tool costs two schemas to save one. The cap decides
  // that on the numbers rather than on a family list.
  it('does not collapse a family with only one collapsible member', () => {
    const single = [sandboxTool('vscode_get_url')];
    const out = applyToolTiering(single, sandboxGroups());
    expect(out.tools.map((t) => t.name)).toEqual(['vscode_get_url']);
    expect(out.collapsedServers).toEqual([]);
  });
});

describe('vendor and sandbox groups together', () => {
  // Vendor groups are supplied first so a vendor tool that happens to share a
  // sandbox prefix is claimed by its server rather than by a sandbox family.
  it('claims a vendor tool by its server, not by a sandbox prefix', () => {
    const tools = [
      ...Array.from({ length: 30 }, (_, i) => tool(`file_op_${i}`, 'vendor-files')),
      ...Array.from({ length: 5 }, (_, i) => sandboxTool(`browser_op_${i}`)),
    ];
    const r = applyToolTiering(tools, [...vendorGroups(tools), ...sandboxGroups()]);
    expect(r.collapsedServers).toContain('vendor-files');
    expect(r.deferred.get('vendor-files')).toHaveLength(30);
  });
});
