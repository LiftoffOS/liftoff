// The 1Password SDK client for a workspace, from the service-account token the
// workspace connected on /connections.
//
// The token is read through the same per-tenant credential resolver every
// BYOK web-tool vendor uses (web-tool-secrets.ts: the 60 s cache, the
// credential pool, the BYOK error path that marks the connector errored on an
// invalid token and clears it when the token works again). Consent is the
// vault the person shared with the service account, so every read here is
// scoped ANY_CONNECTOR: a path that runs as the workspace, not as a team, and
// says so where a reader can see it.
//
// A client signs in as it is created and is kept per workspace for ten
// minutes, keyed by the token's hash so a rotated token gets a fresh client
// at once. The credential cache's invalidation (an errored connector, a
// reprobe that cleared it) drops the client too.

import { createHash } from 'node:crypto';
import type { Client } from '@1password/sdk';
import {
  getWebToolCredential,
  onWebToolCredentialInvalidated,
} from '../web-fetch/web-tool-secrets';
import { ANY_CONNECTOR } from '../web-fetch/credential-scope';

/** How long a signed-in client is kept. */
export const ONEPASSWORD_CLIENT_TTL_MS = 10 * 60_000;

/** The runtime's own version, as telemetry reports it. */
const RUNTIME_VERSION = process.env.SERVICE_VERSION || '1.0.0';

interface ClientEntry {
  client: Client;
  tokenHash: string;
  expiresAt: number;
}

const clients = new Map<string, ClientEntry>();

function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Test seam: how a client is built from a token. Production uses the SDK. */
type ClientFactory = (token: string) => Promise<Client>;
async function sdkClient(token: string): Promise<Client> {
  const { createClient } = await import('@1password/sdk');
  return createClient({ auth: token, integrationName: 'Liftoff', integrationVersion: RUNTIME_VERSION });
}
let clientFactory: ClientFactory = sdkClient;
export function _setOnePasswordClientFactoryForTesting(factory: ClientFactory | null): void {
  clientFactory = factory ?? sdkClient;
  clients.clear();
}

/**
 * The workspace's signed-in client and the connector it came from. Throws
 * what the credential resolver throws (VendorNotConnected,
 * VendorConnectorErrored) and what the SDK throws when the token does not
 * sign in; the caller maps those.
 */
export async function clientFor(tenantId: string): Promise<{ client: Client; connectorId: string }> {
  listenForInvalidation();
  const credential = await getWebToolCredential(tenantId, 'onepassword', ANY_CONNECTOR);
  const tokenHash = tokenHashOf(credential.apiKey);
  const hit = clients.get(tenantId);
  if (hit && hit.tokenHash === tokenHash && hit.expiresAt > Date.now()) {
    return { client: hit.client, connectorId: credential.connectorId };
  }
  const client = await clientFactory(credential.apiKey);
  clients.set(tenantId, { client, tokenHash, expiresAt: Date.now() + ONEPASSWORD_CLIENT_TTL_MS });
  return { client, connectorId: credential.connectorId };
}

/** Drop the workspace's client: the next call signs in again. */
export function dropOnePasswordClient(tenantId: string): void {
  clients.delete(tenantId);
}

// The credential cache's invalidation reaches this cache too: an errored
// connector, or a reprobe that cleared it, must not leave a client signed in
// on a token the platform has stopped trusting. Registered on the first
// client rather than at load, so importing this module has no side effect.
let listening = false;
function listenForInvalidation(): void {
  if (listening) return;
  listening = true;
  onWebToolCredentialInvalidated((tenantId, vendor) => {
    if (vendor === 'onepassword') dropOnePasswordClient(tenantId);
  });
}
