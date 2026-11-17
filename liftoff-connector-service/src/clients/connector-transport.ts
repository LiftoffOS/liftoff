// An authorized way to call a vendor, handed to a client already knowing how to
// authenticate itself.
//
// WHY THIS EXISTS
// ───────────────
// A connector client used to receive CREDENTIALS and decide for itself how to
// spend them. That put the transport decision — "does this connector's token
// get sent as a bearer, or does Composio hold it and sign the call for us?" — at
// every call site, and most clients never imported the Composio helper at all.
//
// Getting it wrong is not loud. `credentialService` returns `accessToken: ''`
// for a composio_managed connector, deliberately, because Composio holds the
// grant. A client that interpolates that empty string sends `Authorization:
// Bearer ` and the vendor answers 401 — indistinguishable from an expired
// credential. A poller doing that 401s every cycle while its Composio account
// is ACTIVE, its token freshly refreshed, and the Connections page shows it
// Connected.
//
// Fixing that defect per call site (a download route, other routes and job
// handlers via `makeGoogleApiFetcher`, the polling clients) only ever covers
// the call sites each fix happens to touch.
//
// So the fix is not another guard. A client that never receives a token cannot
// send an empty one: the failure stops being something to detect and becomes
// something that cannot be written down. `credentialService` decides the
// transport ONCE per connector and hands back a function; the client calls it.
//
// MIGRATION STATE. Clients are being moved onto this incrementally. Until the
// last one lands, `bearerFor()` in composio-transport.ts still guards the
// hand-rolled paths, and `no-direct-fetch.test.ts` freezes the remaining
// direct-`fetch` clients as debt so no NEW one can be added. When that baseline
// is empty, `bearerFor` and `MissingBearerTokenError` are scaffolding and get
// deleted — if they still exist, this migration is not finished.

import { tryComposioProxy } from './composio-transport.js';

/** What a transport needs, and nothing more.
 *
 *  Structural on purpose. Two `ConnectorCredentials` interfaces exist in this
 *  service — `credentials/service.ts` (accessToken optional, what the service
 *  produces) and `clients/types.ts` (accessToken required, what clients
 *  consume) — and picking either here would force the other side to cast. The
 *  transport reads exactly two fields, so it asks for exactly two. */
export interface TransportCredentials {
  accessToken?: string;
  connectorConfig?: Record<string, unknown>;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface ConnectorRequest {
  method: HttpMethod;
  /** ABSOLUTE vendor URL. Composio's per-toolkit proxy bases are inconsistent
   *  (gmail is a bare host, googledrive bakes in `/drive/v3`), so a
   *  base-relative path is only correct for some toolkits. Every transport
   *  takes the absolute URL and the Composio one forwards it verbatim.
   *
   *  NOT YET SUPPORTED — base-relative paths. Two toolkits require them because
   *  Composio templates their base with a per-account value it fills
   *  server-side (jira / confluence, `{{subdomain}}.atlassian.net`): the client
   *  cannot build an absolute URL because it does not know the subdomain. Those
   *  clients therefore cannot migrate onto this transport until it grows a
   *  `baseRelative: true` mode that skips the direct branch entirely — there is
   *  no direct URL to fall back to. Migrating them by "just" passing
   *  `${this.baseUrl}${path}` would send Composio a URL built from a base the
   *  client only guessed at. */
  url: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Calls the vendor with this connector's authorization already applied.
 *
 *  Returns a real `Response` so a migrating client keeps its existing
 *  `resp.ok` / `resp.json()` shape — the same decision `makeGoogleApiFetcher`
 *  made, and for the same reason: the migration should not also be a rewrite of
 *  every call site's error handling. */
export type ConnectorTransport = (req: ConnectorRequest) => Promise<Response>;

function withQuery(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Build the transport for a set of credentials.
 *
 * The branch is taken ONCE, here, on the same signal `tryComposioProxy` uses —
 * `connectorConfig.composioConnectedAccountId` — so the two can never disagree
 * about which connectors are Composio-managed.
 */
export function makeConnectorTransport(
  credentials: TransportCredentials,
  connectorType: string,
): ConnectorTransport {
  const cfg = credentials.connectorConfig;
  const composioManaged = typeof cfg?.composioConnectedAccountId === 'string'
    && cfg.composioConnectedAccountId.length > 0;

  if (composioManaged) {
    return async (req) => {
      // The proxy returns parsed data, not a Response, so it is wrapped back
      // into one. A vendor status recovered from a proxy error is preserved
      // rather than collapsed into 500 — a 404 must stay a 404, or callers
      // that branch on `resp.status` silently change behaviour on migration.
      try {
        const result = await tryComposioProxy<unknown>(credentials, {
          method: req.method,
          path: req.url,
          body: req.body,
          query: req.query,
          headers: req.headers,
        });
        if (!result.handled) {
          // Unreachable: composioManaged was derived from the same field the
          // helper checks. Treated as a defect rather than falling through to
          // a direct call that has no token to send.
          throw new Error(
            `${connectorType}: composio transport selected but tryComposioProxy declined to handle `
            + 'the request — the two disagree about composioConnectedAccountId',
          );
        }
        return jsonResponse(result.data, 200);
      } catch (err) {
        const status = vendorStatusFrom(err);
        if (status === undefined) throw err;
        return jsonResponse({ error: (err as Error).message }, status);
      }
    };
  }

  // Direct-OAuth / API-key connectors hold a real token and spend it themselves.
  return async (req) => {
    if (!credentials.accessToken) {
      // Not a vendor problem. A non-composio connector with no token means the
      // credential never loaded, and sending an empty bearer would surface as a
      // 401 and read as an expired grant.
      throw new Error(
        `${connectorType}: no access token for a direct call. Sending an empty bearer would `
        + 'surface as a vendor 401 and read as an expired credential.',
      );
    }
    return fetch(withQuery(req.url, req.query), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        ...(req.headers ?? {}),
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
  };
}

/** A transport for a PUBLIC, KEYLESS vendor web API.
 *
 *  Some vendors have no credential at all — a public JSON API that the vendor's
 *  own website calls, free at source. The credential-decision hazard that
 *  `makeConnectorTransport` exists to remove does not apply (there is no token
 *  to send as a bearer or to send empty), but two other things do:
 *
 *    1. These endpoints sit behind bot-management that answers a request with
 *       NO browser-shaped headers with a challenge page, so the transport sets
 *       a real User-Agent / Accept / Origin / Referer by default. A caller may
 *       add or override per request.
 *    2. It must NOT send an Authorization header. `makeConnectorTransport`'s
 *       direct branch always does, and refuses an absent token, so a keyless
 *       client cannot use it — which is why this is a separate seam rather than
 *       a flag on that one. It lives in this file so the client that uses it
 *       stays free of a direct `fetch` (see no-direct-fetch.test.ts).
 *
 *  Content-Type is sent only when there is a body, because a bare GET with a
 *  JSON content type is exactly the shape some bot filters distrust. */
export function makePublicWebTransport(
  connectorType: string,
  defaultHeaders: Record<string, string> = DEFAULT_PUBLIC_WEB_HEADERS,
): ConnectorTransport {
  return async (req) => {
    void connectorType;
    const headers: Record<string, string> = {
      ...defaultHeaders,
      ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(req.headers ?? {}),
    };
    return fetch(withQuery(req.url, req.query), {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
  };
}

/** A transport for an x402 PAY-PER-CALL vendor endpoint.
 *
 *  The third sibling: makeConnectorTransport spends a credential,
 *  makePublicWebTransport spends nothing, and this one spends MONEY — a 402
 *  challenge is paid in USDC from the platform x402 wallet and the request
 *  retried with the payment header (x402 v2, src/x402/). Like the public-web
 *  transport it sends browser-shaped headers (many x402 vendors sit behind
 *  the same bot filters) and never an Authorization header: the payment IS
 *  the authorization.
 *
 *  Spending is fenced by x402SpendGuard (per-call cap from the declared
 *  price ×2 floor $0.02, plus global/per-vendor daily ceilings) BEFORE
 *  anything is signed, and a settled payment is re-exposed to the executor
 *  via readX402Receipt(resp) so the paid amount becomes the call's costUsd.
 *
 *  Everything x402 loads lazily on the first paid call: the service boots
 *  with no CDP wallet env, and only an actual payment attempt surfaces
 *  X402NotConfiguredError. This wrapper lives in this file so x402 executors
 *  stay free of a direct `fetch` (no-direct-fetch.test.ts). */
export function makeX402Transport(
  connectorType: string,
  opts?: {
    /** Per-call ceiling in USD; absent → declared price ×2, floor $0.02. */
    maxPaymentAmountUsd?: number;
    /** The vendor's declared per-call price, when the catalog knows it. */
    declaredPriceUsd?: number;
    defaultHeaders?: Record<string, string>;
  },
): ConnectorTransport {
  return async (req) => {
    const { x402Fetch } = await import('../x402/payment-client.js');
    return x402Fetch(connectorType, opts, req);
  };
}

/** Synthetic response headers the x402 transport adds after a settled
 *  payment. Ours, never the vendor's: they exist only on the copy of the
 *  response the transport hands back, so the executor can read what a call
 *  cost without any shared state. Declared here (not in x402/) so reading a
 *  receipt never loads the payment libraries. */
export const X402_PAID_USD_HEADER = 'x-x402-paid-usd';
export const X402_TRANSACTION_HEADER = 'x-x402-transaction';

/** The x402 receipt as an executor consumes it: what this call cost the
 *  wallet. Undefined when the response involved no payment. */
export function readX402Receipt(
  resp: Response,
): { amountUsd: number; transaction?: string } | undefined {
  const paid = resp.headers.get(X402_PAID_USD_HEADER);
  if (paid === null) return undefined;
  const amountUsd = Number(paid);
  if (!Number.isFinite(amountUsd)) return undefined;
  return {
    amountUsd,
    transaction: resp.headers.get(X402_TRANSACTION_HEADER) ?? undefined,
  };
}

/** Browser-shaped headers that get a public vendor API to answer a
 *  server-to-server call instead of returning a bot-challenge page. */
export const DEFAULT_PUBLIC_WEB_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function jsonResponse(data: unknown, status: number): Response {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Pull a vendor HTTP status out of a proxy error so it survives the hop.
 *  Composio surfaces the upstream status in the thrown message. */
function vendorStatusFrom(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const m = message.match(/\b(4\d{2}|5\d{2})\b/);
  return m ? Number(m[1]) : undefined;
}
