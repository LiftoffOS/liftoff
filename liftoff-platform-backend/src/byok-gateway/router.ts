// The BYOK gateway: `/byok/{vendor}/*`.
//
//   today    SDK subprocess ──[customer key in env]──> Anthropic
//                  ▲
//                  └── the agent's own Bash tool can read this
//
//   gateway  SDK subprocess ──[scoped token]──> here ──[customer key]──> Anthropic
//                  ▲                              │
//                  └── revocable, tenant-scoped,  └── counts tokens, sees the 401
//                      worthless to an attacker
//
// The agent's process gets a base URL and a short-lived per-run token. The real
// customer key stays in Secret Manager and is attached here, on the way out. If
// the agent prints its environment it gets something we can revoke with one
// statement, not a credential whose blast radius is the customer's entire
// account with that provider.
//
// The second thing this buys is somewhere for the revocation signal to land.
// The gateway sees the vendor's 401 when a key is revoked and writes
// status = 'revoked'; the settings card already renders that as a NEEDS
// ATTENTION pill and a "Key declined" note. With a raw hand-off, every call
// site would need its own error interpretation.
//
// Mounted BEFORE express.json() and before CORS: the vendor body is forwarded
// byte-exact, the same way the Claude Code proxy forwards Anthropic bodies.

import express, { Router, type Request, type Response } from 'express';
import { log } from '../infrastructure/logging';
import {
  recordProviderKeyRevoked,
  recordProviderKeyVerified,
} from '../tenant-ai-provider-keys/service';
import { readProviderSecret } from '../tenant-ai-provider-keys/secret-storage';
import { googleUpstreamPath } from './google-path';
import { mintVertexAccessToken, vertexHostForLocation } from './vertex-token';
import { getKey } from '../tenant-ai-provider-keys/repository';
import {
  isAiProviderKeyVendor,
  type AiProviderKeyVendor,
} from '../tenant-ai-provider-keys/types';
import { verifyGatewayToken, type GatewaySession } from './token-store';
import { getManagedSubstitution, type ManagedSubstitution } from './managed-fallback';
import {
  beginGatewayRequest,
  completeGatewayRequest,
  recordGatewayRequest,
  type ServedBy,
} from './usage-recorder';
import {
  EMPTY_USAGE,
  HOP_BY_HOP_HEADERS,
  getGatewayAdapter,
  type GatewayTokenUsage,
  type GatewayVendorAdapter,
} from './vendor-adapters';

import {
  BYOK_DECLINED_HEADER,
  BYOK_SERVED_BY_HEADER,
  BYOK_TOKEN_HEADER,
} from './headers';

const MAX_BODY_BYTES = '20mb';

function errorBody(res: Response, status: number, message: string): void {
  res.status(status).json({ type: 'error', error: { type: 'liftoff_byok_gateway', message } });
}

/** The token the subprocess was given. Read from the two places the vendor SDKs
 *  put a credential, because the gateway impersonates each vendor's own front
 *  door: Anthropic clients send `x-api-key` (or an Authorization bearer when
 *  ANTHROPIC_AUTH_TOKEN is set), OpenAI/xAI/Google clients send a bearer or
 *  `x-goog-api-key`. */
function extractToken(req: Request): string | null {
  // Checked FIRST, and it is what the Vertex path uses. The Google SDKs mint an
  // ADC token of their own and put it in `Authorization` before the request
  // leaves; reading that header there would find Liftoff's identity instead of
  // this run's credential. Both SDKs let a caller set an extra header, so the
  // run token gets one of its own and the two never collide.
  const dedicated = req.headers[BYOK_TOKEN_HEADER];
  if (typeof dedicated === 'string' && dedicated.length > 0) return dedicated.trim();

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }
  for (const header of ['x-api-key', 'x-goog-api-key']) {
    const value = req.headers[header];
    if (typeof value === 'string' && value.length > 0) return value.trim();
  }
  return null;
}

/** Rewrite the `model` field of a JSON body. Only the xAI→OpenRouter
 *  substitution needs it; everything else forwards the buffer untouched. */
function rewriteModel(body: Buffer | undefined, rewrite: (m: string) => string): Buffer | undefined {
  if (!body || body.length === 0) return body;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.model !== 'string') return body;
    parsed.model = rewrite(parsed.model);
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    // Not JSON, or not the shape we expected. Forward it unchanged rather than
    // dropping the request: a body we cannot read is still the caller's, and
    // guessing at it is how a proxy corrupts a request.
    return body;
  }
}

/**
 * The vendor path the caller asked for, with its query string.
 *
 * `/byok/{vendor}` is handed to each SDK as its base URL, so what follows the
 * vendor segment is the vendor's own path verbatim — `v1/messages`,
 * `v1/chat/completions`, `v1beta/models/…:streamGenerateContent`. Taken from
 * the route wildcard rather than `req.url`, which inside a mounted router still
 * carries the vendor segment and would be forwarded upstream as part of the
 * path.
 */
function vendorPathAndQuery(req: Request): { path: string; query: string } {
  const wildcard = (req.params as unknown as Record<string, string>)[0] ?? '';
  const questionMark = req.originalUrl.indexOf('?');
  return {
    path: wildcard,
    query: questionMark >= 0 ? req.originalUrl.slice(questionMark) : '',
  };
}

async function callUpstream(
  adapter: GatewayVendorAdapter,
  req: Request,
  body: Buffer | undefined,
  apiKey: string,
  substitution: ManagedSubstitution | null,
  /** Overrides the adapter's own origin. Vertex serves from a per-LOCATION host
   *  and the location belongs to the customer's credential, so the host is a
   *  property of the request rather than of the vendor. */
  originOverride?: string,
  /** Rewrites the path for the account the CUSTOMER's own credential serves.
   *
   *  The managed substitution carries its own `rewritePath` for the same job, and
   *  this is the other side of it: Vertex names the account in the path, and a
   *  client given only a base URL and a key does not speak Vertex's grammar at
   *  all (see google-path.ts). Only the google vendor has either problem, which
   *  is why both arrive as optional overrides rather than living in the adapter. */
  rewritePath?: (path: string) => string,
): Promise<globalThis.Response> {
  const raw = vendorPathAndQuery(req);
  // The substitution's rewrite wins when there is one — it is serving a different
  // account than the caller addressed. Otherwise the caller's own credential
  // decides, and for Vertex that still means naming an account and a grammar.
  const path = substitution?.rewritePath
    ? substitution.rewritePath(raw.path)
    : rewritePath
      ? rewritePath(raw.path)
      : raw.path;
  const query = raw.query;
  const base = substitution?.baseUrlOverride ?? substitution?.originOverride ?? originOverride;
  // A substituted base can carry its own path prefix (OpenRouter serves at
  // /api/v1), so the vendor's leading `v1/` is dropped and the rest joined
  // RELATIVE to it. Resolving `/v1/…` against it as an absolute path would
  // discard `/api/v1` and hit the wrong host root. A bare origin override —
  // Vertex's per-location host — has no prefix to preserve, so it resolves
  // absolutely exactly like the adapter's own base.
  const url = substitution?.baseUrlOverride
    ? new URL(
        `${path.replace(/^v1\//, '')}${query}`,
        base!.endsWith('/') ? base! : `${base!}/`,
      )
    : base
      ? new URL(`/${path}${query}`, base)
      : adapter.buildUpstreamUrl(`/${path}${query}`);

  // Three layers, in this order and for this reason: the vendor's defaults so a
  // caller that sends none still gets a valid request; then the caller's own
  // allow-listed headers, which override those defaults; then the credential,
  // which overrides everything so nothing a client sent can displace it.
  const headers: Record<string, string> = { ...adapter.defaultRequestHeaders };
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (!adapter.allowedRequestHeaders.has(lower)) continue;
    if (typeof value === 'string') headers[lower] = value;
  }
  Object.assign(headers, adapter.buildAuthHeaders(apiKey));

  const outboundBody = substitution?.rewriteModel
    ? rewriteModel(body, substitution.rewriteModel)
    : body;

  return fetch(url, {
    method: req.method,
    headers,
    // Uint8Array rather than the Buffer itself: undici's BodyInit does not
    // accept Node's Buffer type, the same conversion the Claude Code proxy
    // makes on its own forward.
    body: outboundBody?.length ? Uint8Array.from(outboundBody) : undefined,
  });
}

/**
 * Record that the provider honoured the key, at most once every few minutes per
 * (tenant, vendor).
 *
 * `last_verified_at` is what makes a stale `valid` diagnosable, and for that it
 * only has to be roughly current. Writing it on every successful request would
 * put an UPDATE on the hot path of the busiest thing the platform does — one
 * row write per LLM call, on a row nothing reads between saves.
 */
const lastVerifiedTouch = new Map<string, number>();
const VERIFIED_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function touchVerifiedOccasionally(tenantId: string, vendor: AiProviderKeyVendor): void {
  const key = `${tenantId}:${vendor}`;
  const last = lastVerifiedTouch.get(key) ?? 0;
  if (Date.now() - last < VERIFIED_TOUCH_INTERVAL_MS) return;
  lastVerifiedTouch.set(key, Date.now());
  void recordProviderKeyVerified(tenantId, vendor);
}

/** True when the vendor is telling us the credential is not honoured.
 *
 *  401 and 403 only. A 429 is a live account being rate limited, which PROVES
 *  the key works — the vendor had to authenticate it to know whose quota to
 *  charge — and marking that key revoked would take a working key out of
 *  service for a burst of traffic. */
function isCredentialRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** Read the whole response, teeing usage out of it, and hand the bytes on.
 *
 *  Streaming and non-streaming both land here. SSE is parsed line by line for
 *  the vendor's own usage events; a JSON body is parsed once at the end. Either
 *  way the client gets the exact bytes the vendor sent. */
async function forwardWithUsageTee(
  adapter: GatewayVendorAdapter,
  upstream: globalThis.Response,
  res: Response,
  /** Written through rather than returned, so a caller that has to record usage
   *  in a `finally` still sees everything captured before the stream died. */
  accumulator: { current: GatewayTokenUsage },
): Promise<void> {
  const contentType = upstream.headers.get('content-type') ?? '';
  const isEventStream = contentType.includes('text/event-stream');

  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (!adapter.safeResponseHeaders.has(lower)) return;
    res.setHeader(name, value);
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let pending = '';

  const consumeLine = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return;
    try {
      accumulator.current = adapter.accumulateStreamUsage(
        accumulator.current,
        JSON.parse(payload) as Record<string, unknown>,
      );
    } catch {
      // A data line we cannot parse is not a reason to break the stream the
      // customer is watching. The usage row records what we did capture.
    }
  };

  const chunks: Buffer[] = [];
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    res.write(buffer);
    if (isEventStream) {
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) consumeLine(line.replace(/\r$/, ''));
    } else {
      chunks.push(buffer);
    }
  }
  if (isEventStream && pending.length > 0) consumeLine(pending.replace(/\r$/, ''));
  res.end();

  if (!isEventStream && chunks.length > 0) {
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      accumulator.current = adapter.parseNonStreamingUsage(parsed) ?? accumulator.current;
    } catch {
      // Same reasoning as above: an unparseable body is still the vendor's
      // answer and has already been forwarded.
    }
  }
}

export function createByokGatewayRouter(): Router {
  const router = Router();

  // Byte-exact capture before the app-level express.json() can consume it.
  router.use(express.raw({ type: '*/*', limit: MAX_BODY_BYTES }));

  router.all('/:vendor/*', async (req: Request, res: Response) => {
    const vendor = String(req.params.vendor);
    const adapter = getGatewayAdapter(vendor);
    if (!adapter) {
      errorBody(res, 404, `Unknown vendor: ${vendor}`);
      return;
    }

    const token = extractToken(req);
    if (!token) {
      errorBody(res, 401, 'Missing gateway credential');
      return;
    }

    let session: GatewaySession | null;
    try {
      session = await verifyGatewayToken(token);
    } catch (error) {
      log.error(
        { event: 'byok_gateway_token_lookup_failed', error: (error as Error).message },
        'BYOK gateway could not verify a token',
      );
      errorBody(res, 503, 'Gateway unavailable');
      return;
    }
    // One answer for an unknown, expired, revoked or malformed token. The
    // difference between them is only useful to somebody guessing.
    if (!session) {
      errorBody(res, 401, 'Invalid or expired gateway credential');
      return;
    }
    // A token minted for one vendor cannot be spent at another's door, or a
    // compromised run could reach every provider the tenant has a key for.
    if (session.vendor !== vendor) {
      errorBody(res, 403, 'Gateway credential is not valid for this vendor');
      return;
    }

    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

    // A MANAGED SESSION NEVER LOOKS FOR A CUSTOMER KEY.
    //
    // Whose key pays was decided once, when the session opened, and it is carried
    // on the token. Re-deciding it here would be a second place for the same
    // question to be answered, and it would answer differently the moment a
    // workspace on Liftoff's key happens to hold one for the same vendor: the
    // run would silently start spending the customer's account because a
    // by-product of counting tokens went looking for a key.
    //
    // It also means `openrouter` is servable at all. That door has no
    // customer-funded side — the invoice is Liftoff's and no key exists for it —
    // so a lookup would be a query for a vendor the keys table cannot hold.
    const managedSession = session.mode === 'managed';

    // The vendor AS AN ACCOUNT A CUSTOMER COULD HOLD A KEY FOR, or null.
    //
    // Null two ways, and both have to be null-safe rather than cast away. A
    // managed session has no customer key to look for by construction. And the
    // gateway serves one door — `openrouter` — that is not in the key vocabulary
    // at all, because an OpenRouter invoice is Liftoff's: `getKey` could not be
    // called for it even if something wanted to. Everything below that touches
    // the stored key is gated on this, so nothing needs a cast and nothing can
    // reach the key path for a vendor that has no keys.
    const keyVendor = !managedSession && isAiProviderKeyVendor(session.vendor)
      ? session.vendor
      : null;

    const stored = keyVendor ? await getKey(session.tenantId, keyVendor) : null;
    const credential =
      stored && stored.status === 'valid' ? await readProviderSecret(stored.secretName) : null;

    // 'byok' means "the customer's key is what we are trying", which a managed
    // session is not. Set before the attempt rather than after, because it is
    // what `beginGatewayRequest` writes BEFORE the first byte goes out and what
    // the ledger counts to decide the run's cost bucket — a managed session
    // recorded as 'byok' would zero-rate a turn Liftoff paid for.
    let servedBy: ServedBy = managedSession ? 'managed' : 'byok';
    let declined = false;
    let upstream: globalThis.Response | null = null;

    // What actually goes on the wire, and where.
    //
    // For the three key-issuing vendors this is the stored key itself. For
    // Google it is an OAuth access token minted from the stored service account
    // — the key pair never leaves this process — and the host is the one that
    // serves the customer's own Vertex location.
    //
    // A failed exchange is a DECLINE, not an outage: a deleted key, a disabled
    // service account and a revoked role all fail here rather than at Vertex,
    // and every one of them means the credential has stopped working.
    let outboundSecret: string | null = null;
    let originOverride: string | undefined;
    let rewritePath: ((path: string) => string) | undefined;
    if (credential && keyVendor) {
      if (credential.kind === 'vertex_service_account') {
        try {
          outboundSecret = await mintVertexAccessToken(credential);
          originOverride = `https://${vertexHostForLocation(credential.location)}`;
          // THE CUSTOMER'S OWN account, and the same two-grammar problem the
          // managed substitution has: a client given only this door's base URL
          // and a run token speaks the Gemini Developer API, which Vertex does
          // not serve. Translated against their project rather than ours, because
          // this token is theirs.
          rewritePath = (path) =>
            googleUpstreamPath(path, credential.project, credential.location);
        } catch (error) {
          declined = true;
          log.warn(
            {
              event: 'byok_vertex_token_exchange_failed',
              tenantId: session.tenantId,
              error: (error as Error).message,
            },
            'Customer Vertex service account could not be exchanged for a token',
          );
          void recordProviderKeyRevoked(session.tenantId, keyVendor);
        }
      } else {
        outboundSecret = credential.apiKey;
      }
    }

    if (outboundSecret && keyVendor) {
      try {
        upstream = await callUpstream(
          adapter, req, body, outboundSecret, null, originOverride, rewritePath,
        );
      } catch (error) {
        log.error(
          {
            event: 'byok_gateway_upstream_error',
            vendor,
            tenantId: session.tenantId,
            error: (error as Error).message,
          },
          'BYOK gateway could not reach the vendor on the customer key',
        );
        upstream = null;
      }

      if (upstream && isCredentialRejection(upstream.status)) {
        declined = true;
        // The signal has somewhere to land, which is half the reason this
        // service exists. Marking the key is what puts NEEDS ATTENTION on the
        // card, and it is also what STOPS US RETRYING it: the resolver refuses
        // a revoked key, so the next turn goes straight to managed rather than
        // paying a round trip to learn the same thing again.
        void recordProviderKeyRevoked(session.tenantId, keyVendor);
        // Drain the rejected response so the connection is not left open.
        await upstream.text().catch(() => undefined);
        upstream = null;
      } else if (upstream && upstream.ok) {
        void touchVerifiedOccasionally(session.tenantId, keyVendor);
      }
    }

    // ── Liftoff's own key ─────────────────────────────────────────────────
    //
    // Reached two ways, and the difference matters only to the ledger, which
    // already has it in `served_by`. A MANAGED SESSION arrives here directly:
    // this run was always going to be paid for by Liftoff and it came through the
    // door so its tokens could be counted. A BYOK session arrives here as a
    // FALLBACK — no key, a declined key, or a transport failure on the customer's
    // account — and section 6 is explicit that the turn in flight completes on
    // our key and bills as normal customer consumption.
    if (!upstream) {
      servedBy = 'managed';
      const substitution = await getManagedSubstitution(vendor, session.purpose);
      if (!substitution) {
        // Nothing to substitute. For a BYOK session that is a protocol boundary:
        // tell the caller plainly so its own adapter can re-run the turn on the
        // managed path, rather than surfacing a bare 401 that reads like a
        // platform bug.
        //
        // For a MANAGED session it is the one way this door can turn a working
        // turn into a failed one. `canSubstituteManaged` established the
        // credential existed when the session opened, so reaching here means it
        // stopped existing mid-run — a pool key rotated out, ADC unable to mint,
        // `GCP_PROJECT_ID` unset. That run had a perfectly good direct path and
        // was pointed here only to be counted, so it is ERROR: the fault is
        // ours, not a customer key's.
        if (managedSession) {
          log.error(
            {
              event: 'byok_managed_session_lost_its_substitution',
              vendor,
              tenantId: session.tenantId,
              invocationId: session.invocationId,
              purpose: session.purpose,
            },
            'BYOK gateway had no managed credential for a session it had already promised one to; '
            + 'this run was routed here only to be counted and has now failed',
          );
        }
        res.setHeader(BYOK_DECLINED_HEADER, declined ? '1' : '0');
        res.setHeader(BYOK_SERVED_BY_HEADER, 'managed');
        await recordGatewayRequest({
          tenantId: session.tenantId,
          invocationId: session.invocationId,
          vendor,
          agentId: session.agentId,
          purpose: session.purpose,
          servedBy: 'managed',
          sessionMode: session.mode,
          usage: { ...EMPTY_USAGE },
          statusCode: 502,
        });
        errorBody(
          res,
          502,
          managedSession
            // No workspace key is involved, so saying one was declined would send
            // whoever reads this to the wrong card.
            ? 'No managed credential is available for this provider right now.'
            : declined
              ? 'The provider declined this workspace key. Retry on the managed path.'
              : 'Could not reach the provider on this workspace key. Retry on the managed path.',
        );
        return;
      }
      try {
        upstream = await callUpstream(adapter, req, body, substitution.apiKey, substitution);
      } catch (error) {
        log.error(
          {
            event: 'byok_gateway_managed_upstream_error',
            vendor,
            tenantId: session.tenantId,
            error: (error as Error).message,
          },
          'BYOK gateway could not reach the vendor on the managed key either',
        );
        await recordGatewayRequest({
          tenantId: session.tenantId,
          invocationId: session.invocationId,
          vendor,
          agentId: session.agentId,
          purpose: session.purpose,
          servedBy: 'managed',
          sessionMode: session.mode,
          usage: { ...EMPTY_USAGE },
          statusCode: 502,
        });
        errorBody(res, 502, 'Failed to reach the provider');
        return;
      }
    }

    res.setHeader(BYOK_DECLINED_HEADER, declined ? '1' : '0');
    res.setHeader(BYOK_SERVED_BY_HEADER, servedBy);

    const status = upstream.status;

    // Open the usage row BEFORE forwarding a single byte. The ledger decides
    // this run's cost bucket by counting these rows, and a row written after
    // the response has gone out can land after the run has finished, published
    // and settled — a short count reads as "not BYOK" and double-charges a turn
    // the customer already paid their provider for. `served_by` is already
    // decided here; only the token counts still have to be waited for.
    const requestRowId = await beginGatewayRequest({
      tenantId: session.tenantId,
      invocationId: session.invocationId,
      vendor,
      agentId: session.agentId,
      purpose: session.purpose,
      servedBy,
      sessionMode: session.mode,
    });

    // The accumulator lives OUT here, and the row is closed in a finally,
    // because a stream that dies half way through has still spent tokens. If
    // the counts were only written on the success path, the one request most
    // worth seeing — the one that broke — would be the one with no usage, and
    // the invariant would hold everywhere except where it matters.
    const usage: { current: GatewayTokenUsage } = { current: { ...EMPTY_USAGE } };
    try {
      await forwardWithUsageTee(adapter, upstream, res, usage);
    } finally {
      // Written for EVERY request, whoever's key paid and whatever the vendor
      // answered. A row saying "we charged nothing for this" is only auditable
      // if it also says what "this" was.
      if (requestRowId) {
        await completeGatewayRequest(requestRowId, session.tenantId, usage.current, status);
      } else {
        // The row could not be opened. One write at the end is worse — it can
        // lose the race described above — but it is far better than no record
        // at all, which breaks the invariant outright.
        await recordGatewayRequest({
          tenantId: session.tenantId,
          invocationId: session.invocationId,
          vendor,
          agentId: session.agentId,
          purpose: session.purpose,
          servedBy,
          sessionMode: session.mode,
          usage: usage.current,
          statusCode: status,
        });
      }
    }
  });

  return router;
}
