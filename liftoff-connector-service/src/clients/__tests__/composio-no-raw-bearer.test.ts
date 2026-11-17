// A composio_managed client must never interpolate an access token into an
// Authorization header.
//
// WHY. `credentialService.getCredentials` returns `accessToken: ''` for every
// composio_managed connector, deliberately — Composio holds the token and the
// only way to spend it is `tools.proxyExecute`. A client that writes
// `Bearer ${credentials.accessToken}` therefore sends `Bearer ` and the vendor
// answers 401, which is indistinguishable from an expired grant.
//
// That is not hypothetical. `GoogleMailClient.list()` did exactly this. It was
// the only method on that client with its own fetch — read/search/thread all
// went through `request()`, which proxies — so Gmail 401'd on every poll for
// hours while the Composio account was ACTIVE, its token had just refreshed,
// and the Connections page showed the connector as Connected. The agent could
// read a thread handed to it and could never be woken by one.
//
// `bearerFor()` turns that into an error that names the client and says the
// call belongs on the proxy path. This test is what stops the next client from
// reintroducing the raw form, because the runtime guard only helps where
// somebody remembered to call it.
//
// Scope: composio_managed types ONLY. A direct-OAuth connector (Salesforce,
// Zendesk, DocuSign, …) holds a real bearer and interpolating it is correct.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONNECTORS } from '../../catalog/connectors.js';

const CLIENT_DIR = join(__dirname, '..');

/** `Bearer ${anything.accessToken}` — the raw form, in any local variable. */
const RAW_BEARER = /Bearer \$\{[A-Za-z_$][\w$]*\.accessToken\}/g;

interface ClientFile {
  file: string;
  connectorType: string;
  rawBearerCount: number;
}

function composioManagedClients(): ClientFile[] {
  const out: ClientFile[] = [];
  for (const file of readdirSync(CLIENT_DIR)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const src = readFileSync(join(CLIENT_DIR, file), 'utf8');
    const m = src.match(/readonly connector\s*=\s*'([^']+)'/);
    if (!m) continue;
    const connectorType = m[1];
    const def = CONNECTORS[connectorType] as { mcp?: { kind?: string } } | undefined;
    if (def?.mcp?.kind !== 'composio_managed') continue;
    out.push({
      file,
      connectorType,
      rawBearerCount: (src.match(RAW_BEARER) ?? []).length,
    });
  }
  return out;
}

describe('composio_managed clients never send a raw bearer token', () => {
  const clients = composioManagedClients();

  it('finds the composio_managed clients to check', () => {
    // Guards the guard: a rename that stops matching `readonly connector` would
    // make every assertion below pass vacuously.
    expect(clients.length).toBeGreaterThan(20);
  });

  it.each(clients.map((c) => [c.file, c]))('%s uses bearerFor(), not a raw token', (_file, client) => {
    const c = client as ClientFile;
    expect({ file: c.file, connectorType: c.connectorType, rawBearerCount: c.rawBearerCount })
      .toEqual({ file: c.file, connectorType: c.connectorType, rawBearerCount: 0 });
  });

  it('google_mail and google_calendar are among those checked', () => {
    // The two that actually broke. If either drops out of this set — renamed,
    // retyped, or its `readonly connector` field changed — the regression this
    // file exists for would stop being covered silently.
    const types = clients.map((c) => c.connectorType);
    expect(types).toContain('google_mail');
    expect(types).toContain('google_calendar');
  });
});
