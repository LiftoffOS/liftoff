// Audit lint: enforce the canonical connection-id contract.
//
// The /connections page exposes Gmail, Slack, custom_mcp_server, tunneled
// MCP, and future API connectors as ONE row each in `connectors`.
// `connectors.id` is the canonical identifier the entire system uses —
// agent integration bindings store it, /connections URLs use it, secret
// names embed it. Type-specific tables (custom_mcp_servers,
// connector_credentials, mcp_tunnel_routes) reference it via FK.
//
// When a type-specific table also has its own local `id` UUID PK and an
// internal-router endpoint accidentally queries `WHERE id = $1` against
// that local PK, the endpoint diverges from the canonical contract:
// callers pass `connectors.id` (the only id they know), the local PK
// lookup 404s, and the connection silently goes dark from the runtime's
// perspective. A break like that can go unnoticed for weeks.
//
// This test scans every internal-router under src/**/internal-router.ts
// for SQL of the form `WHERE id = $1` against any connection-typed
// table. If found, it fails with a pointer to the offending line so the
// contract violation is caught in CI, not in prod.

import fs from 'fs';
import path from 'path';

const REPO_SRC = path.resolve(__dirname, '../../..', 'src');

// Tables that carry a `connector_id` FK to `connectors(id)`. Any
// internal-router that filters on these tables by `id = $1` is suspect
// — the canonical key is `connector_id`, not the local PK.
const CONNECTOR_SCOPED_TABLES = [
  'custom_mcp_servers',
  'connector_credentials',
  'mcp_tunnel_routes',
];

// Routers exempt from the check (admin-only paths that legitimately
// take the local PK from operator tooling rather than from the agent
// runtime). Empty for now — add with a justification comment if ever
// needed.
const EXEMPT_FILES: string[] = [];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, acc);
    } else if (entry.isFile() && /internal-router(\.|-).*\.ts$/.test(entry.name)) {
      acc.push(full);
    } else if (entry.isFile() && entry.name === 'internal-router.ts') {
      acc.push(full);
    }
  }
  return acc;
}

describe('connector-id contract — internal routers do not query connection-typed tables by local id', () => {
  it('every internal-router resolves connections by connector_id, not local PK', () => {
    const offenders: string[] = [];
    const routers = walk(REPO_SRC);
    expect(routers.length).toBeGreaterThan(0);

    for (const file of routers) {
      if (EXEMPT_FILES.some((e) => file.endsWith(e))) continue;
      const source = fs.readFileSync(file, 'utf8');

      for (const table of CONNECTOR_SCOPED_TABLES) {
        // Match SQL like:
        //   FROM <table> WHERE id = $1
        //   UPDATE <table> SET ... WHERE id = $2
        //   DELETE FROM <table> WHERE id = $1
        // Tolerates whitespace, line breaks, and a leading column list.
        const fromWhereId = new RegExp(
          `(FROM|UPDATE|DELETE\\s+FROM)\\s+${table}\\b[^;]*?\\bWHERE\\s+id\\s*=\\s*\\$\\d`,
          'is',
        );
        if (fromWhereId.test(source)) {
          offenders.push(
            `${path.relative(REPO_SRC, file)}: query against ${table} uses WHERE id = $N. ` +
            `The canonical key is connector_id (= connectors.id). Change to WHERE connector_id = $N.`,
          );
        }
      }
    }

    if (offenders.length > 0) {
      const message = [
        'Connector-id contract violation in internal-router(s):',
        ...offenders.map((o) => `  - ${o}`),
        '',
        'Fix: rewrite the query to filter by connector_id. The agent runtime, ',
        '/connections URLs, and secret names all use connectors.id; routing ',
        'a runtime lookup through any other identifier silently breaks the connection.',
      ].join('\n');
      throw new Error(message);
    }
  });
});
