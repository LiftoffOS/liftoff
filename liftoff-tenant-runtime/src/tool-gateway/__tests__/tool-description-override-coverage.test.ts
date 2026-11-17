// Every path that describes a tool to a model applies the per-tool overrides.
//
// This is the enumerating half, in the style of provenance-dispatch-paths.ts,
// and it exists because the thing it guards is invisible in review. There are
// THREE places a tool description reaches a model, and they do not share a
// bottom:
//
//   1. buildToolGatewayAndCatalog -> registerToolCatalog — the adapter catalog.
//   2. createToolGatewayMcpServer — mounted DIRECTLY by the Claude Agent SDK
//      engine via `mcpServers`, so its tools never pass through (1). That is
//      the default engine.
//   3. buildToolsForAgent — the sandbox's own MCP surface.
//
// I shipped this feature into (1) alone. It typechecked, its unit tests passed,
// and the rule reached no tool on the default engine — INV-TR-019's failure
// exactly: correct-looking in review, silently absent depending on which engine
// a tenant happens to be running.
//
// It reads the SOURCE rather than driving the three paths, deliberately.
// Driving them proves the paths that exist today behave; reading them proves a
// path added tomorrow cannot quietly not behave, which is the property that
// decays.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Every file that turns a connector function into a described tool. */
const DESCRIBING_PATHS = [
  ['adapter catalog', 'agent-execution/service.ts'],
  ['tool-gateway MCP server', 'tool-gateway/mcp-server.ts'],
  ['sandbox tool surface', 'tool-gateway/tools-builder.ts'],
] as const;

describe('every describing path applies the overrides', () => {
  it.each(DESCRIBING_PATHS)('%s', (_label, rel) => {
    const src = read(rel);
    const applies = src.includes('applyToolDescriptionOverrides')
      || src.includes('describeWith(');
    expect(applies).toBe(true);
  });

  it.each(DESCRIBING_PATHS)('%s imports the SHARED helper', (_label, rel) => {
    // Two copies drift. The rule has to be one implementation all three call,
    // which is what INV-TR-019 means by "the shared helpers".
    expect(read(rel)).toMatch(/from '[^']*tool-description-overrides'/);
  });
});

describe('the helper is shared, not duplicated', () => {
  it('is defined exactly once', () => {
    const defs = DESCRIBING_PATHS
      .map(([, rel]) => read(rel))
      .filter((s) => /export function applyToolDescriptionOverrides|export function describeWith/.test(s));
    expect(defs).toEqual([]);
  });
});

describe('the MCP server receives what it needs to apply them', () => {
  it('takes the overrides as an input', () => {
    // A path that applies overrides it is never given applies nothing, and
    // reads in a diff exactly like a path that works.
    expect(read('tool-gateway/mcp-server.ts')).toContain('toolDescriptionOverrides?: Record<string, string>');
  });

  it('is PASSED them by the run path', () => {
    const svc = read('agent-execution/service.ts');
    const at = svc.indexOf('createToolGatewayMcpServer({');
    expect(at).toBeGreaterThan(-1);
    expect(svc.slice(at, at + 600)).toContain('toolDescriptionOverrides');
  });
});

describe('the destructive marker still leads', () => {
  it.each([
    ['tool-gateway/mcp-server.ts'],
    ['tool-gateway/tools-builder.ts'],
  ])('%s appends the rule after the warning', (rel) => {
    // The level-2 destructive gate reads the marker, and a rule prepended ahead
    // of it would push the warning out of the position both the gate and the
    // model expect it in.
    const src = read(rel);
    const call = src.slice(src.indexOf('describeWith('));
    expect(call.indexOf('DESTRUCTIVE')).toBeLessThan(call.indexOf('toolDescriptionOverrides'));
  });
});
