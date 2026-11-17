// A custom MCP server's credential is read under the name PB stored it as, and
// a server that cannot produce one is not called.
//
// Two defects, one visible symptom.
//
// 1. NAME. PB creates these secrets as `custom-mcp-server-<serverId>-<tenantId>`
//    and hands the name back on the config as `authSecretName`. The handler
//    ignored it and called getCredentials, which derives the canonical
//    per-connector name `connector-<tenantId>-<connectorId>` — a name no custom
//    MCP server has ever had. Secret Manager answers a missing secret with
//    PERMISSION_DENIED rather than NOT_FOUND, so the failure reads like a broken
//    IAM grant and sends an investigation after permissions.
//
// 2. SILENCE. The read failure was a `warn` reading "falling back to no auth",
//    and resolveVendorEntry then returned the server with EMPTY headers. The
//    request went out unauthenticated, the vendor answered 401, and the log said
//    `vendor_mcp_enumerate_auth_failed` — as though a credential had been
//    rejected rather than never sent. There is no case where silently dropping
//    authentication and proceeding is better than stopping.
//
// Together: every enumeration of the server answers 401, the agent's catalog
// holds zero of its tools, and the agent falls back to `curl` via shell_exec —
// raising a destructive-tool approval for a documentation lookup.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'custom-mcp-server-handler.ts'), 'utf8');
const CATALOG = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf8');

describe('the credential is read under the stored name', () => {
  it('passes config.authSecretName into getCredentials', () => {
    const call = SRC.slice(
      SRC.indexOf('const creds = await this.getCredentials('),
      SRC.indexOf('const creds = await this.getCredentials(') + 420,
    );
    expect(call).toContain('config.authSecretName');
  });

  it('accepts a stored name and prefers it over the derived one', () => {
    expect(SRC).toContain('storedSecretName?: string');
    expect(SRC).toContain('storedSecretName || getConnectorSecretName(tenantId, connectorId)');
  });

  it('keeps the canonical name as the fallback, so existing callers are unchanged', () => {
    // Callers with no stored name must behave exactly as before.
    expect(SRC).toContain('getConnectorSecretName(tenantId, connectorId)');
  });
});

describe('a server that declares auth is never called without it', () => {
  it('returns null instead of an entry with empty headers', () => {
    const block = SRC.slice(
      SRC.indexOf('const headers: Record<string, string> = {};'),
      SRC.indexOf("return { type: 'http', url: config.endpointUrl, headers };"),
    );
    expect(block).toMatch(/refusing to connect unauthenticated/);
    expect(block).toContain('return null;');
  });

  it('logs the failure at ERROR with the name and project it tried', () => {
    // The whole reason this took a manual secret comparison to find: the log
    // said the vendor rejected us, not which secret we asked for.
    const creds = SRC.slice(SRC.indexOf('private async getCredentials('));
    expect(creds).toContain("'Failed to read custom MCP server credentials'");
    expect(creds).toMatch(/logger\.error\(/);
    expect(creds).toContain('secretName');
    expect(creds).toContain('projectId');
    expect(creds).toContain('usedStoredName');
  });

  it('no longer describes dropping auth as a fallback', () => {
    expect(SRC).not.toContain('falling back to no auth');
  });

  it('treats an empty payload as an error too, not a quiet none', () => {
    expect(SRC).toContain('custom MCP credential secret is empty');
  });
});

describe('a server that contributes nothing says so', () => {
  it('logs when a bound custom MCP server is dropped from the catalog', () => {
    // A bare `continue` here lets a server bound to an agent contribute no
    // tools while looking correctly configured.
    const block = CATALOG.slice(
      CATALOG.indexOf("if (integration.type === 'custom_mcp_server') {"),
      CATALOG.indexOf("if (integration.type === 'custom_mcp_server') {") + 2000,
    );
    expect(block).toContain('vendor_mcp_custom_mcp_unresolved');
    expect(block).toMatch(/contributes NO tools/);
    expect(block).not.toMatch(/if \(!entry\) continue;/);
  });
});
