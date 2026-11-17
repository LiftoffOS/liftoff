// Thin wrapper around @composio/core for the OAuth router's
// composio_managed branch.
//
// The router never touches the Composio SDK directly so the surface area
// is one file: link an account (returns the redirect URL + connected
// account id), then poll until the connected account becomes ACTIVE on
// callback. Liftoff never sees the underlying OAuth tokens — Composio
// holds them.
//
// SDK shape conforms to @composio/core@0.10.x:
//   - `connectedAccounts.link(userId, authConfigId, options)` returns a
//     `ConnectionRequest` ({ id, redirectUrl, status, waitForConnection })
//     where `id` is the connected-account id used to poll status.
//   - `connectedAccounts.get(id)` returns the current state of the row.
//   - We poll explicitly (not `waitForConnection`) because the
//     ConnectionRequest object is created in /start and the /callback
//     handler — running in a separate request — only has the id string.

import { Composio } from '@composio/core';
import { CONNECTORS } from '../catalog/connectors.js';

// Lazy-init the SDK client so the router module can be imported in tests
// (and in deployments that don't use Composio yet) without the secret
// mounted. The check fires the first time someone actually links/polls a
// Composio-managed connector, which is the codepath that needs the key.
let composioInstance: Composio | null = null;

/**
 * Build the per-toolkit version map the Composio SDK requires for manual
 * execution. @composio/core >= 0.2.0 rejects manual `tools.execute` calls
 * with `ComposioToolVersionRequiredError` ("Toolkit version not specified.
 * For manual execution of the tool please pass a specific toolkit version")
 * unless versions are pinned either per-call or at SDK initialization.
 *
 * The TypeScript type union accepts `toolkitVersions: 'latest'` as a global
 * literal, but the runtime rejects it for manual execute paths — verified by
 * reading the deployed SDK source (@composio/core/dist/CustomTool-*.cjs:225
 * has the example "❌ This will throw ComposioToolVersionRequiredError if
 * toolkitVersions is 'latest'", with the fix being the per-toolkit `Record`
 * form). Build the Record once from CONNECTORS so the set stays in sync as
 * connectors are added/removed.
 *
 * 'latest' is the Composio-recommended value for each toolkit when outputs
 * are consumed by an LLM. See:
 * https://docs.composio.dev/docs/tools-direct/toolkit-versioning
 */
function buildToolkitVersions(): Record<string, 'latest'> {
  const out: Record<string, 'latest'> = {};
  for (const def of Object.values(CONNECTORS)) {
    if (def.mcp?.kind === 'composio_managed' && def.mcp.toolkitSlug) {
      out[def.mcp.toolkitSlug] = 'latest';
    }
  }
  return out;
}

export function getComposio(): Composio {
  if (composioInstance) return composioInstance;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error('COMPOSIO_API_KEY required');
  }
  composioInstance = new Composio({
    apiKey,
    toolkitVersions: buildToolkitVersions(),
  });
  return composioInstance;
}


/**
 * Minimal shape the router reads from a Composio connected-account row.
 * We do NOT re-export the SDK's `ConnectedAccountRetrieveResponse` so
 * consumers of this module don't bind themselves to the SDK version's
 * exact field set (which is wider than what we need and changes between
 * minor releases).
 */
export interface ComposioConnectedAccount {
  id: string;
  status: 'ACTIVE' | 'INITIATED' | 'INITIALIZING' | 'FAILED' | 'EXPIRED' | 'INACTIVE' | 'REVOKED' | string;
  statusReason?: string | null;
  /**
   * Toolkit-specific identity params (account_email, workspace_name, …).
   * Marked `@deprecated` in the SDK in favour of `state` but still
   * populated; we read both via the identity extractor.
   */
  params?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

/**
 * Start a Composio connect by handing the user Composio's hosted Connect Link
 * page. `link.create` is the ONLY supported way in — see ADR-050.
 *
 * We used to skip this page: leg 1 created the connection, then we called
 * `connectedAccounts.refresh()` ourselves to get the direct vendor-OAuth
 * shortlink, so the user never saw Composio's form. That bypass is retired.
 *
 * Why it had to go, in order of severity:
 *
 *  1. The refresh endpoint is DEPRECATED, and a change on Composio's side
 *     can take the entire OAuth flow down. The `callbackUrl` here is
 *     attached to the link session (`lk_…`) — the very thing the bypass threw
 *     away — so the post-OAuth redirect depended on Composio inheriting it
 *     onto the connection. If that inheritance stops, every connect
 *     dead-ends on Composio's own page. Passing `redirect_url` on refresh
 *     works around it, but only by leaning harder on the deprecated
 *     endpoint. Of the three endpoints that can produce an OAuth
 *     URL, `initiate` is retired and `refresh` is deprecated; this is the one
 *     that is neither.
 *
 *  2. The bypass was silently WRONG for per-tenant fields. Eight OAuth
 *     toolkits declare `expected_input_fields` that differ per customer —
 *     Jira/Confluence subdomain, Mailchimp server prefix, Google Ads customer
 *     id, WhatsApp WABA id, Dynamics org, Gong base URL, QuickBooks. The
 *     composio branch of /start never collected them (`dynamicUrlParams` is
 *     read there but only ever used by the legacy vendor-OAuth path), and
 *     skipping the form meant nothing else did either. The hosted page is the
 *     only surface that asks. QuickBooks — whose four fields are true
 *     constants — was the case the bypass was actually built for, and it is
 *     the exception, not the rule.
 *
 * The cost is real and accepted: 8 of 43 OAuth toolkits now show one extra
 * form; the other 35 declare no fields and pass straight through. Prefilling
 * `connection_data` does NOT suppress the form (verified: the
 * hosted page renders byte-identical props with and without it), so there is
 * no way to keep the page and hide the form.
 */
export async function linkComposioAccount(args: {
  authConfigId: string;
  tenantId: string;
  callbackUrl: string;
}): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const composio = getComposio();

  const link = await composio.connectedAccounts.link(
    args.tenantId, // userId == tenant_id
    args.authConfigId,
    {
      // The hosted page carries this through to the connection when the user
      // submits, which is what brings the browser back to our /callback.
      callbackUrl: args.callbackUrl,
      allowMultiple: true, // critical for multi-account support per tenant
    },
  );

  // Fail loudly rather than handing the popup `undefined`. A link with no
  // redirect URL is unusable, and /start returning 500 is far easier to
  // diagnose than a blank popup.
  if (!link.redirectUrl) {
    throw new Error(`Composio link() returned no redirectUrl for ${link.id}`);
  }
  return { redirectUrl: link.redirectUrl, connectedAccountId: link.id };
}

/** Returned by pollConnectedAccountActive when the deadline is reached with
 * the row still in INITIATED/INITIALIZING. Distinct from a hard FAILED so
 * the /callback handler can decide policy (retry, return-to-user, etc.). */
export class ComposioConnectionPendingError extends Error {
  constructor(public readonly connectedAccountId: string, public readonly lastStatus: string) {
    super(
      `Composio connection ${connectedAccountId} still ${lastStatus} after polling deadline — ` +
      `Composio will eventually mark it ACTIVE but /callback already returned.`,
    );
    this.name = 'ComposioConnectionPendingError';
  }
}

/**
 * Poll Composio for the connected account's terminal status.
 *
 * Default 30s deadline (was 15s). The user already completed consent in the
 * browser by the time /callback fires, so we're racing Composio's own
 * pipeline that flips INITIATED → ACTIVE — typically sub-second, but can
 * spike under load. 30s gives the pipeline more room without making
 * /callback feel slow.
 *
 * Orphan caveat: if we time out, Composio may still mark the row ACTIVE
 * later. The user retries → fresh link() with `allowMultiple: true` → a
 * NEW ACTIVE row is created, the old one is orphaned (and billed for).
 * The right long-term fix is to NOT consume the oauth_state row until
 * polling succeeds (then the retry just polls again); that's a /callback
 * refactor and out of scope. For now we throw `ComposioConnectionPendingError`
 * so callers can log it distinctly and operators can grep orphans by
 * matching `connectedAccountId` against Composio's connected-account list.
 */
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
// Tolerate a few consecutive transient SDK errors (network blip, Composio
// 5xx, etc.) before giving up. The poll loop is the only path that decides
// "the user's connection is dead" — without retry, a single hiccup
// produces an orphan ACTIVE row in Composio that we'd never reconcile.
const MAX_CONSECUTIVE_TRANSIENT_ERRORS = 5;

function isTransientSdkError(err: unknown): boolean {
  // Heuristic: anything that's not a clear "you're done" signal counts as
  // transient and gets retried while we have time on the deadline. The
  // poll terminates on its deadline regardless — worst case we throw
  // ComposioConnectionPendingError, identical to the timeout path.
  const e = err as { name?: string; code?: number; statusCode?: number };
  // Composio-typed terminal errors propagate out untouched.
  if (e?.name === 'ComposioConnectedAccountNotFoundError') return false;
  if (e?.name === 'ComposioAuthConfigNotFoundError') return false;
  return true;
}

export async function pollConnectedAccountActive(
  connectedAccountId: string,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<ComposioConnectedAccount> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'UNKNOWN';
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    let acc: ComposioConnectedAccount;
    try {
      acc = (await getComposio().connectedAccounts.get(
        connectedAccountId,
      )) as unknown as ComposioConnectedAccount;
    } catch (err) {
      if (!isTransientSdkError(err)) throw err;
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_TRANSIENT_ERRORS) {
        throw new Error(
          `Composio polling failed ${consecutiveErrors}x consecutively for ${connectedAccountId}: ${(err as Error).message}`,
        );
      }
      // Linear backoff: 500ms, 1s, 1.5s, 2s, 2.5s. Total worst case ~8s
      // of retry budget before bailing — well under the 30s deadline.
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * consecutiveErrors));
      continue;
    }
    consecutiveErrors = 0;
    lastStatus = acc.status;
    if (acc.status === 'ACTIVE') return acc;
    if (acc.status === 'FAILED' || acc.status === 'EXPIRED' || acc.status === 'REVOKED') {
      throw new Error(
        `Composio connection ${acc.status}: ${acc.statusReason ?? 'no reason given'}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new ComposioConnectionPendingError(connectedAccountId, lastStatus);
}

// ──────────────────────────────────────────────────────────────────────────
// Credential adapter helpers — composio_managed routing.
//
// Composio's `connectedAccounts.get()` / `refresh()` endpoints return the
// OAuth token as the literal string `"REDACTED"` (the v3 API never exposes
// real tokens to the integrator — verified against both REST
// and SDK paths). The only path to call a vendor API with a
// composio_managed connector's credentials is to route the request through
// Composio itself via `composio.tools.proxyExecute(...)`, which signs the
// outbound request server-side using the held token.
//
// As a result, the credential-service composio branch DOES NOT attempt to
// hand a usable bearer token to vendor clients. It returns the
// connectedAccountId in `ConnectorCredentials.connectorConfig` so the
// client class can choose the Composio-proxied transport.
// ──────────────────────────────────────────────────────────────────────────

export class ComposioAccountNotActiveError extends Error {
  constructor(
    public readonly connectedAccountId: string,
    public readonly accountStatus: string,
    public readonly statusReason: string | null | undefined,
  ) {
    super(
      `Composio connected account ${connectedAccountId} is ${accountStatus}` +
        (statusReason ? ` (${statusReason})` : '') +
        ' — re-run OAuth to recover',
    );
    this.name = 'ComposioAccountNotActiveError';
  }
}

/** Verify a Composio connected account is in `ACTIVE` state. Used by the
 *  credential-service composio branch before returning composio-routed
 *  credentials, so callers don't issue Composio proxy calls against a
 *  REVOKED / EXPIRED account and get cryptic vendor errors. */
export async function assertComposioAccountActive(
  connectedAccountId: string,
): Promise<void> {
  const acc = (await getComposio().connectedAccounts.get(
    connectedAccountId,
  )) as unknown as ComposioConnectedAccount;
  if (acc.status !== 'ACTIVE') {
    throw new ComposioAccountNotActiveError(connectedAccountId, acc.status, acc.statusReason);
  }
}

/**
 * Proxy an HTTP request to a vendor API through Composio. Composio signs
 * the request with the connected account's held OAuth token (which we never
 * see) and forwards it. The vendor response is returned to the caller
 * verbatim under `.data`.
 *
 * Generic transport — used by every connector client that needs to make
 * vendor REST calls when the bound credential is composio_managed.
 */
export async function composioProxyRequest<T = unknown>(args: {
  connectedAccountId: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint: string;
  body?: unknown;
  queryParams?: Record<string, string | number>;
  headers?: Record<string, string>;
}): Promise<T> {
  const parameters: Array<{ in: 'query' | 'header'; name: string; value: string | number }> = [];
  if (args.queryParams) {
    for (const [name, value] of Object.entries(args.queryParams)) parameters.push({ in: 'query', name, value });
  }
  if (args.headers) {
    for (const [name, value] of Object.entries(args.headers)) parameters.push({ in: 'header', name, value });
  }
  const resp = await getComposio().tools.proxyExecute({
    endpoint: args.endpoint,
    method: args.method,
    body: args.body as never,
    parameters,
    connectedAccountId: args.connectedAccountId,
  });
  const status = (resp as { status?: number }).status ?? 0;
  if (status >= 400) {
    const errBody =
      typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? {});
    throw new Error(
      `Composio proxy ${args.method} ${args.endpoint}: HTTP ${status} ${errBody.slice(0, 500)}`,
    );
  }
  return resp.data as T;
}

/**
 * A binary response Composio staged for us.
 *
 * When a proxied vendor call returns bytes rather than JSON, Composio streams
 * them to its own file backend and puts a short-lived signed URL on the
 * response under `binary_data` — the vendor's bytes never pass through this
 * process. `composioProxyRequest` returns `resp.data` and therefore DROPS that
 * field, which is the whole reason binary was believed impossible over
 * Composio: the transport was discarding the only part of the response that
 * carried it.
 */
export interface ComposioBinaryRef {
  url: string;
  contentType?: string;
  size?: number;
  expiresAt?: string;
}

/**
 * Proxy a request whose response is expected to be a file, and return the
 * signed URL Composio staged it at.
 *
 * Returns null when the response carried no `binary_data` — the caller decides
 * whether that is an error (a document download that came back as JSON) or a
 * benign miss. `@composio/core` 0.10.0's `tools.proxyExecute` passes the raw
 * client response through untransformed, so the field arrives under its wire
 * name `binary_data` (the camelCase `binaryData` mapping in that SDK version
 * exists only on the tool-router SESSION proxy, which is a different method).
 */
export async function composioProxyBinaryDownload(args: {
  connectedAccountId: string;
  endpoint: string;
  queryParams?: Record<string, string | number>;
}): Promise<ComposioBinaryRef | null> {
  const parameters: Array<{ in: 'query' | 'header'; name: string; value: string | number }> = [];
  if (args.queryParams) {
    for (const [name, value] of Object.entries(args.queryParams)) parameters.push({ in: 'query', name, value });
  }
  const resp = (await getComposio().tools.proxyExecute({
    endpoint: args.endpoint,
    method: 'GET',
    parameters,
    connectedAccountId: args.connectedAccountId,
  })) as {
    status?: number;
    data?: unknown;
    binary_data?: { url?: string; content_type?: string; size?: number; expires_at?: string };
    binaryData?: { url?: string; contentType?: string; size?: number; expiresAt?: string };
  };

  const status = resp.status ?? 0;
  if (status >= 400) {
    const errBody = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? {});
    throw new Error(
      `Composio proxy GET ${args.endpoint}: HTTP ${status} ${errBody.slice(0, 500)}`,
    );
  }

  // Accept both spellings so an SDK upgrade that starts camelCasing this
  // method's response does not silently turn every download into a null.
  const snake = resp.binary_data;
  if (snake?.url) {
    return {
      url: snake.url,
      contentType: snake.content_type,
      size: snake.size,
      expiresAt: snake.expires_at,
    };
  }
  const camel = resp.binaryData;
  if (camel?.url) {
    return {
      url: camel.url,
      contentType: camel.contentType,
      size: camel.size,
      expiresAt: camel.expiresAt,
    };
  }
  return null;
}

/**
 * Proxy a request that CARRIES bytes (a file upload).
 *
 * Goes to the REST endpoint directly rather than through `@composio/core`:
 * the `binary_body` request field does not exist in the 0.10.0 SDK's proxy
 * params (verified against the bundled dist — `binary_data` appears,
 * `binary_body` does not), so the SDK would drop the payload and PUT an empty
 * body, which Graph accepts as a zero-byte file. A silent empty upload is a
 * worse failure than a loud one, so this path does not go through the SDK
 * until a version ships that models the field.
 */
export async function composioProxyBinaryUpload(args: {
  connectedAccountId: string;
  method: 'POST' | 'PUT' | 'PATCH';
  endpoint: string;
  content: Buffer;
  contentType: string;
}): Promise<{ status: number; data: unknown }> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set — cannot upload through the Composio proxy');

  const resp = await fetch('https://backend.composio.dev/api/v3/tools/execute/proxy', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: args.endpoint,
      method: args.method,
      connected_account_id: args.connectedAccountId,
      binary_body: {
        base64: args.content.toString('base64'),
        content_type: args.contentType,
      },
    }),
  });

  const payload = (await resp.json().catch(() => ({}))) as { status?: number; data?: unknown };
  const status = payload.status ?? resp.status;
  if (!resp.ok || status >= 400) {
    throw new Error(
      `Composio proxy ${args.method} ${args.endpoint}: HTTP ${status} ` +
      `${JSON.stringify(payload.data ?? payload).slice(0, 500)}`,
    );
  }
  return { status, data: payload.data };
}

/** Delete a Composio connected account so the upstream OAuth grant is
 *  released. Called from `revokeCredentials` for composio_managed
 *  connectors so disconnect-from-the-UI doesn't leave Composio holding
 *  a dangling row that still bills + still authorizes. */
export async function deleteComposioConnectedAccount(
  connectedAccountId: string,
): Promise<void> {
  await getComposio().connectedAccounts.delete(connectedAccountId);
}

/** Create a Composio trigger instance for the given connectedAccountId
 *  + slug. Composio polls the vendor (or receives vendor webhooks for
 *  webhook-type triggers) and POSTs to the project-level webhook URL
 *  configured in Composio dashboard
 *  (<this deployment>/api/internal/composio-webhook).
 *
 *  Idempotent at Composio's layer: re-calling for the same
 *  (connectedAccountId, slug) returns the existing trigger instead of
 *  creating a duplicate — per Composio's create-or-upsert semantics
 *  (verified empirically; matches the `upsert` verb used in the SDK's
 *  param-schema name `TriggerInstanceUpsertParams`). */
export async function createComposioTriggerInstance(args: {
  tenantId: string;
  slug: string;
  connectedAccountId: string;
  triggerConfig?: Record<string, unknown>;
}): Promise<{ triggerId: string }> {
  const composio = getComposio();
  const resp = await composio.triggers.create(
    args.tenantId,
    args.slug,
    {
      connectedAccountId: args.connectedAccountId,
      triggerConfig: args.triggerConfig,
    },
  );
  return { triggerId: resp.triggerId };
}

/** Delete a Composio trigger by its instance id. Called from
 *  `revokeCredentials` / disconnect flows for composio_managed connectors
 *  so we don't keep paying for polling on a connector we no longer use. */
export async function deleteComposioTrigger(triggerId: string): Promise<void> {
  await getComposio().triggers.delete(triggerId);
}
