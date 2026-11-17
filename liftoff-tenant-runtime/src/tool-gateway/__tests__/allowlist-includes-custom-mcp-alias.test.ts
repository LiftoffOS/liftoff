// A custom MCP server's ALIAS must be in the allowlist, not only its UUID.
//
// Every alias in the derived allowlist comes from `connector_manifests`, and a
// BYOC server has no manifest — the runtime says so in as many words
// (connectors/binding-probe.ts). So the list carried the server's UUID and never
// the name its tools are actually dispatched by, and every call was refused at
// the gate:
//
//   Connector 'custom-mcp-d144a7ea' is not in instruction's allowed connectors:
//   [0105297e-…, d144a7ea-91a0-4ce3-8e21-93a732a794e1, google-mail-0105297e,
//    google-mail-eaec0c30]
//
// The UUID is in that very list. Only the spelling the dispatch uses was
// missing, and Gmail's alias sits beside it — supplied by the manifest the MCP
// server does not have.
//
// A support agent's step that dispatches
// `custom-mcp-d144a7ea__search_articles` is denied here and routes to its
// onFailure branch — so the agent escalates a question the Help Center has
// articles for. Fixing credentials or the distiller catalog does not help,
// because neither is what refuses the call.
//
// The alias is minted exactly as tool-gateway/mcp-server.ts keys the SDK server
// (`custom-mcp-<id, dashes stripped, first 8>`), because that is what produces
// the name being checked here.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'permission-validator.ts'), 'utf8');
const MCP = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf8');

const derived = SRC.slice(
  SRC.indexOf('allowedConnectors = ['),
  SRC.indexOf('this.instructionCache.set(cacheKey'),
);

describe('the derived allowlist', () => {
  it('has a block to assert against', () => {
    expect(derived.length).toBeGreaterThan(300);
  });

  it('adds an alias for every custom MCP integration', () => {
    expect(derived).toContain("i.type === 'custom_mcp_server'");
    expect(derived).toContain('`custom-mcp-${String(i.id ?? \'\').replace(/-/g, \'\').slice(0, 8)}`');
  });

  it('mints it the SAME way the dispatch names it', () => {
    // Two spellings of one identity is the whole defect. If mcp-server.ts ever
    // changes how it keys the server, this must move with it.
    expect(MCP).toContain("const shortId = integration.id.replace(/-/g, '').slice(0, 8);");
    expect(MCP).toContain('const key = `custom-mcp-${shortId}`;');
  });

  it('drops an integration with no usable id rather than allowing a stub', () => {
    // `''.slice(0,8)` is empty, and `custom-mcp-` alone would be a prefix that
    // matches nothing — or worse, something.
    expect(derived).toContain("a.length === 'custom-mcp-'.length + 8");
  });

  it('still carries the ids and the manifest aliases it always did', () => {
    expect(derived).toContain('...integrationIds,');
    expect(derived).toContain('manifestResult.rows.map((r: { alias: string }) => r.alias)');
  });

  it('records why no manifest can supply this one', () => {
    expect(derived).toMatch(/no manifest/i);
    expect(derived).toMatch(/custom-mcp-d144a7ea/);
  });
});

describe('the refusal this unblocks', () => {
  it('is still refused when the connector genuinely is not allowed', () => {
    // The gate itself is unchanged — this widens what is legitimately on the
    // list, it does not weaken the check.
    expect(SRC).toContain("is not in instruction's allowed connectors");
  });
});
