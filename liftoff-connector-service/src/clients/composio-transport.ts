// Shared composio_managed routing helper for every connector client that
// needs to call a vendor REST API.
//
// Composio's v3 API returns access_token as the literal string "REDACTED"
// for both REST and SDK paths — the only way to call
// a vendor API with a composio_managed connector's credentials is via
// `composio.tools.proxyExecute()`, which signs the outbound request
// server-side using the held token.
//
// Each client's `request(method, path, body, options)` method delegates
// to `tryComposioProxy(...)` BEFORE building its direct-HTTP path. When
// the bound credentials are composio_managed (detected via
// `connectorConfig.composioConnectedAccountId`), the helper handles the
// request and returns the response. Otherwise it returns `{ handled:
// false }` and the client falls back to its own direct-HTTP path.
//
// Putting this in one helper instead of inline-per-client means a future
// migration off Composio is a single-file delete + the inline detection
// branch in each client; the rest of each client's code stays unchanged.
//
// IMPORTANT — follow Composio's documented `endpoint` contract. Per the docs
// (https://docs.composio.dev/docs/proxy-execute) and ToolProxyParams, `endpoint`
// is "an absolute URL, or a path relative to the base URL of the connected
// account." That base URL is authoritative and knowable — Composio publishes it
// per toolkit (`GET /api/v3/toolkits/{slug}` → `base_url`, also on the connected
// account's `data.base_url`) — and it VARIES: some toolkits use a bare host
// (gmail `www.googleapis.com`, slack `slack.com/api`), others bake in the API
// version (googledrive `www.googleapis.com/drive/v3`, box `api.box.com/2.0`).
// A hardcoded version-prefix (`/drive/v3${path}`) is therefore only correct for
// the bare-host toolkits; for the versioned ones it DOUBLES the segment and hits
// the vendor's 404. Rather than track each toolkit's base, pass the ABSOLUTE
// vendor URL — the exact URL each client's direct-HTTP fallback already builds
// (`${this.baseUrl}${path}`). Composio signs+forwards it verbatim; cross-host is
// allowed within the toolkit's registrable domain (a Slides account can call the
// Drive API). Exceptions that MUST stay base-relative: toolkits whose base_url is
// templated with a per-account value Composio fills server-side (jira/confluence
// `{{subdomain}}.atlassian.net`) — the client can't build the absolute URL.

import type { ConnectorCredentials } from './types.js';

export interface ComposioProxyArgs {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** ABSOLUTE vendor URL (e.g. `https://www.googleapis.com/drive/v3/files`).
   *  See the file header: Composio's per-toolkit base URLs are inconsistent,
   *  so a base-relative/version-prefixed path is unreliable. */
  path: string;
  body?: unknown;
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
}

export type ComposioProxyResult<T> =
  | { handled: true; data: T }
  | { handled: false };

/** Raised when a client is about to send a bearer token it does not have.
 *
 *  Distinct from a vendor 401 on purpose: a 401 says "the vendor rejected our
 *  credentials", which sends whoever reads it to check the credentials. This
 *  says "we never had credentials to send", which sends them to the code. */
export class MissingBearerTokenError extends Error {
  constructor(
    public readonly connectorType: string,
    /** True when the bound credential is composio_managed, which is the case
     *  where an empty token is EXPECTED and the direct path is the bug. */
    public readonly composioManaged: boolean,
  ) {
    super(
      composioManaged
        ? `${connectorType}: a composio_managed connector has no bearer token by design `
          + `(credentialService returns accessToken: ''), so this call must go through `
          + `tryComposioProxy(). Reaching the direct-HTTP path here is a bug in the client, `
          + `not a credential problem — route the call through the client's request() method.`
        : `${connectorType}: no access token available for a direct-HTTP call. Sending an `
          + `empty bearer would surface as a vendor 401 and read as an expired credential.`,
    );
    this.name = 'MissingBearerTokenError';
  }
}

/**
 * The token for a direct-HTTP call, or a loud failure.
 *
 * WHY THIS EXISTS. `credentialService.getCredentials` returns
 * `accessToken: ''` for every composio_managed connector, deliberately — the
 * token is held by Composio and the only way to spend it is
 * `tools.proxyExecute`. A client that interpolates that empty string into an
 * `Authorization: Bearer ` header produces a vendor 401, and a 401 is
 * indistinguishable from an expired grant. Gmail's poller did exactly that and
 * 401'd on every cycle for hours while its Composio account was healthy, its
 * token fresh, and the Connections page showed it connected.
 *
 * Failing here converts that into an error naming the client and the reason,
 * at the moment the wrong path is taken, instead of a vendor status code that
 * sends everyone to look at the credential.
 */
export function bearerFor(credentials: ConnectorCredentials, connectorType: string): string {
  const token = credentials.accessToken;
  if (!token) {
    // Detected the same way tryComposioProxy detects it, from the same field,
    // so the guard and the router can never disagree about which credentials
    // are composio_managed.
    const cfg = credentials.connectorConfig;
    const composioManaged = typeof cfg?.composioConnectedAccountId === 'string'
      && cfg.composioConnectedAccountId.length > 0;
    throw new MissingBearerTokenError(connectorType, composioManaged);
  }
  return token;
}

/** When `credentials.connectorConfig.composioConnectedAccountId` is set,
 *  route the request through `composio.tools.proxyExecute(...)` and return
 *  `{ handled: true, data }`. Otherwise return `{ handled: false }` so the
 *  caller's direct-HTTP path runs. */
export async function tryComposioProxy<T>(
  // Structural: the helper reads only `connectorConfig`, and both credential
  // shapes in this service satisfy that. Widened so the transport factory can
  // pass the service's shape without a cast.
  credentials: { connectorConfig?: Record<string, unknown> },
  args: ComposioProxyArgs,
): Promise<ComposioProxyResult<T>> {
  const cfg = credentials.connectorConfig;
  const composioConnectedAccountId =
    cfg && typeof cfg.composioConnectedAccountId === 'string'
      ? (cfg.composioConnectedAccountId as string)
      : '';
  if (!composioConnectedAccountId) return { handled: false };

  // Dynamic import keeps the @composio/core dependency lazy — clients
  // that never run for a composio_managed connector never pay the
  // import cost (and tests for non-composio paths don't need Composio
  // mocked).
  const { composioProxyRequest } = await import('../oauth/composio-client.js');
  const data = await composioProxyRequest<T>({
    connectedAccountId: composioConnectedAccountId,
    method: args.method,
    endpoint: args.path,
    body: args.body,
    queryParams: args.query,
    headers: args.headers,
  });
  return { handled: true, data };
}
