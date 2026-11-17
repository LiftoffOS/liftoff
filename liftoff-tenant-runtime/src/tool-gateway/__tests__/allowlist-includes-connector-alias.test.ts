// An ORDINARY connector's dispatch alias must be in the allowlist, not only
// its UUID.
//
// The sibling test (allowlist-includes-custom-mcp-alias) fixed this for BYOC
// MCP servers on the reasoning that such a server has no `connector_manifests`
// row to supply an alias. That reasoning is right and the scope was wrong: a
// manifest is not guaranteed for ANY connector. When one is missing, the only
// spelling the allowlist carries is the raw UUID, which is never the name the
// dispatch is called by.
//
// A code-review agent's first step is then refused on a live pull_request
// event —
//
//   Connector 'github-dd4c4689' is not in instruction's allowed connectors:
//   [dd4c4689-e1d6-4464-8592-f8fdac0edf0d, github-7d07a896]
//
// The connector being called is in that list, as a UUID; beside it is a
// SIBLING GitHub connector's alias, supplied by the manifest that one happens
// to have. Two GitHub connectors can be mirror images where neither works —
// an App connector dispatches but has no manifest so it is denied here, an
// OAuth connector has a manifest but no installation so it is dropped from the
// catalog. Every GitHub connector call then fails and the agent falls back to
// running `gh` in the sandbox, where the action ledger and the duplicate guard
// cannot see it.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'permission-validator.ts'), 'utf8');
const MCP = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf8');

const derived = SRC.slice(
  SRC.indexOf('allowedConnectors = ['),
  SRC.indexOf('this.instructionCache.set(cacheKey'),
);

describe('the derived allowlist carries the dispatch alias', () => {
  it('has a block to assert against', () => {
    expect(derived.length).toBeGreaterThan(300);
  });

  it('mints an alias for non-custom-MCP integrations too', () => {
    // Not just the custom_mcp_server branch: the general case must be covered
    // or a connector without a manifest is denied its own tools.
    expect(derived).toContain("i.type !== 'custom_mcp_server'");
    expect(derived).toContain('`${i.type}-${shortId}`');
  });

  it('falls back to the `connector-` prefix when the integration has no type', () => {
    // mcp-server.ts keys an untyped integration this way; the allowlist has to
    // agree or that connector is denied under a name nothing produces.
    expect(derived).toContain('`connector-${shortId}`');
    expect(MCP).toContain('`connector-${shortId}`');
  });

  it('uses the SAME minting rule the dispatch uses', () => {
    // The alias is only correct because it is derived identically. If
    // mcp-server.ts changes how it keys a connector, this must change with it.
    const rule = /replace\(\/-\/g, ''\)\.slice\(0, 8\)/;
    expect(rule.test(derived)).toBe(true);
    expect(rule.test(MCP)).toBe(true);
  });

  it('drops a short id that is not a full 8 characters', () => {
    // The allowlist check treats a trailing '*' as a prefix wildcard, and a
    // truncated short id is a prefix of other connectors' aliases. A malformed
    // entry must be dropped rather than widen the allowlist.
    expect(derived).toContain('shortId.length !== 8');
  });

  it('still covers the custom-MCP case it was extended from', () => {
    // The two branches are disjoint by construction (`!==` here, `===` there),
    // so extending the general case must not have removed the special one.
    expect(derived).toContain("i.type === 'custom_mcp_server'");
    expect(derived).toContain('custom-mcp-');
  });
});
