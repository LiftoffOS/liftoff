// A deleted account's credentials stop resolving.
//
// Closing the dashboard is not closing the account. Both MCP credential paths
// resolved a token by checking the TOKEN - its status, its expiry, its own
// deleted_at - and never the person it belonged to, so a deleted account's
// coding tool kept full access while the dashboard refused them. The account
// condition is read per call, like the token's own status, so the credential
// follows the account's current state rather than being revoked by anything
// (INV-PB-014).
//
// Asserted over the source text on purpose. These queries have no database in
// the unit suite, and a mocked client would only prove the text was passed
// through; the property is a property of the statement.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

/** The statement a query appears in, so the assertion is about one statement. */
function statementContaining(source: string, needle: string): string {
  const at = source.indexOf(needle);
  if (at === -1) throw new Error(`could not find ${needle}`);
  const open = source.lastIndexOf('`', at);
  const close = source.indexOf('`', at);
  return source.slice(open, close + 1);
}

describe("a deleted account's MCP credentials stop resolving", () => {
  it('the static-token lookup constrains on the account', () => {
    const sql = statementContaining(read('mcp-server/mcp-auth.ts'), 'FROM mcp_tokens');
    expect(sql).toMatch(/JOIN\s+accounts\s+a\s+ON\s+a\.id\s*=\s*t\.account_id/);
    expect(sql).toMatch(/a\.deleted_at\s+IS\s+NULL/);
  });

  it('the OAuth access-token lookup constrains on the account', () => {
    const sql = statementContaining(read('oauth/verifier.ts'), 'FROM oauth_access_tokens');
    expect(sql).toMatch(/JOIN\s+accounts\s+a\s+ON\s+a\.id\s*=\s*g\.account_id/);
    expect(sql).toMatch(/a\.deleted_at\s+IS\s+NULL/);
  });

  it('neither lookup can pass vacuously', () => {
    // If a refactor moved these statements, the helper above would throw
    // rather than silently matching nothing.
    expect(statementContaining(read('mcp-server/mcp-auth.ts'), 'FROM mcp_tokens').length)
      .toBeGreaterThan(80);
    expect(statementContaining(read('oauth/verifier.ts'), 'FROM oauth_access_tokens').length)
      .toBeGreaterThan(80);
  });
});

describe('the purge cannot be switched off', () => {
  it('reads no environment variable that would disable it', () => {
    // A switch here would recreate the state the purge exists to end - rows
    // marked deleted and never removed - and would do it silently, because
    // the product reports the deletion either way.
    const purge = read('maintenance/purge-soft-deleted.ts');
    expect(purge).not.toContain('SOFT_DELETE_PURGE_DISABLED');
    expect(purge).toContain('export function startPurgeWorker');
  });
});
