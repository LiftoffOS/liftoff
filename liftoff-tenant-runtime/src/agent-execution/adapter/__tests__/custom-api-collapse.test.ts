// FEATURE TEST 3 — an oversized custom API connection collapses BY INSTANCE,
// an operation a workflow names stays loaded, and every collapsed operation
// keeps its classification.
//
// Connecting a custom API is connecting the API: every operation the
// specification describes becomes available, up to two hundred of them. Three
// things follow, and each has a failure behind it:
//
//   * The model must not be handed two hundred schemas. The existing collapse
//     enumerates `kind: 'remote'` servers only — vendor-hosted MCP plus
//     `custom_mcp_server` — so these in-process connector tools got no collapse
//     for free.
//   * A tool the run's own steps NAME must never be collapsed.
//     `isAlwaysLoadedTool` is a static list and does not read prompts, so a
//     `tool_call` step whose tool is behind a search pair is a step whose
//     contract depends on the model running a search first.
//   * Collapsing is a CATALOG-SIZE decision and must not be a governance one.
//     A collapsed vendor server used to keep only name, description and schema,
//     so every seam past the model answered "unknown" for all of its tools.

import {
  applyToolTiering,
  customApiConnectorGroups,
  workflowNamedToolNames,
  parseTieredToolName,
} from '../tool-tiering';
import type { McpToolDefinition } from '../catalog-types';

const ALIAS_A = 'custom-api-connector-1a2b3c4d';
const ALIAS_B = 'custom-api-connector-9f8e7d6c';

function operation(alias: string, name: string, categories: string[]): McpToolDefinition {
  return {
    name: `${alias}__${name}`,
    description: `Operation ${name}`,
    inputSchema: { type: 'object', properties: {} },
    serverId: 'liftoff-tool-gateway',
    source: 'connector',
    categories,
  } as McpToolDefinition;
}

/** A connection with `n` operations: reads, one write and one destructive one
 *  carrying a sensitivity category the Sensitive Work settings match. */
function connection(alias: string, n: number): McpToolDefinition[] {
  const out: McpToolDefinition[] = [];
  for (let i = 0; i < n - 2; i++) out.push(operation(alias, `get_thing_${i}`, ['read']));
  out.push(operation(alias, 'create_invoice', ['write', 'dataChanges', 'financialActions']));
  out.push(operation(alias, 'delete_customer', ['destructive', 'dataChanges']));
  return out;
}

describe('an oversized custom API connection', () => {
  it('collapses by INSTANCE, so one workspace connection does not crowd out another', () => {
    const tools = [...connection(ALIAS_A, 60), ...connection(ALIAS_B, 5)];

    const tiered = applyToolTiering(tools, customApiConnectorGroups([ALIAS_A, ALIAS_B]));

    // The big one collapsed; the small one is untouched.
    expect(tiered.collapsedServers).toEqual([ALIAS_A]);
    const names = tiered.tools.map((t) => t.name);
    expect(names).toContain(`search_${ALIAS_A.replace(/-/g, '_')}_tools`);
    expect(names).toContain(`call_${ALIAS_A.replace(/-/g, '_')}_tool`);
    expect(names.filter((n) => n.startsWith(`${ALIAS_A}__`))).toHaveLength(0);
    expect(names.filter((n) => n.startsWith(`${ALIAS_B}__`))).toHaveLength(5);

    // Grouped by connector id, which the alias carries: the second connection's
    // operations are in their own group and were never candidates for the
    // first's search pair.
    expect(tiered.deferred.get(ALIAS_A)).toHaveLength(60);
    expect(tiered.deferred.get(ALIAS_B)).toBeUndefined();

    // The synthetic pair resolves back to the group it was built for.
    expect(parseTieredToolName(`search_${ALIAS_A.replace(/-/g, '_')}_tools`))
      .toEqual({ kind: 'search', serverKey: ALIAS_A.replace(/-/g, '_') });
  });

  it('keeps an operation a workflow step NAMES, while collapsing the rest', () => {
    const tools = connection(ALIAS_A, 60);
    const steps = [
      { toolName: `${ALIAS_A}__create_invoice` },
      { toolName: 'get_thing_7' }, // authored bare, as a distilled graph may
    ];

    const alwaysLoaded = workflowNamedToolNames(steps, tools);
    const tiered = applyToolTiering(tools, customApiConnectorGroups([ALIAS_A]), undefined, alwaysLoaded);

    const names = tiered.tools.map((t) => t.name);
    expect(tiered.collapsedServers).toEqual([ALIAS_A]);
    // Both spellings resolved to the catalog's own name and both survived.
    expect(names).toContain(`${ALIAS_A}__create_invoice`);
    expect(names).toContain(`${ALIAS_A}__get_thing_7`);
    // Everything else went behind the pair.
    expect(names).not.toContain(`${ALIAS_A}__get_thing_8`);
    expect(names).toContain(`search_${ALIAS_A.replace(/-/g, '_')}_tools`);
  });

  it('contributes no search pair when every operation in it is workflow-named', () => {
    // A pair offering zero tools is two schemas the model pays for and can
    // never use. Reachable only because the always-loaded set is per RUN: no
    // static exemption could empty a group that was over its cap.
    const tools = connection(ALIAS_A, 30);
    const alwaysLoaded = workflowNamedToolNames(tools.map((t) => ({ toolName: t.name })), tools);

    const tiered = applyToolTiering(tools, customApiConnectorGroups([ALIAS_A]), undefined, alwaysLoaded);

    expect(tiered.collapsedServers).toEqual([]);
    expect(tiered.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(tiered.tools.some((t) => t.name.startsWith('search_'))).toBe(false);
  });

  it('a collapsed operation keeps its classification, so the gate is not blinded', () => {
    const tools = connection(ALIAS_A, 60);

    const tiered = applyToolTiering(tools, customApiConnectorGroups([ALIAS_A]));
    const deferred = tiered.deferred.get(ALIAS_A) ?? [];

    const destructive = deferred.find((t) => t.name === `${ALIAS_A}__delete_customer`);
    expect(destructive?.categories).toEqual(['destructive', 'dataChanges']);

    // The sensitivity name matters as much as the effect token: the Sensitive
    // Work settings match these LITERALLY out of a tool's categories, so a
    // collapsed financial write must still read as financial.
    const write = deferred.find((t) => t.name === `${ALIAS_A}__create_invoice`);
    expect(write?.categories).toEqual(['write', 'dataChanges', 'financialActions']);

    // Nothing lost its schema either — the search pair resolves the real tool
    // and dispatches it as itself.
    expect(write?.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});
