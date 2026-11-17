// "Whose key pays for this run, and how do I reach it?"
//
// The runtime never holds a customer's provider key and never learns whether one
// exists beyond the answer to that one question. It asks the control plane,
// which owns the keys, and gets back either "managed" — carry on exactly as
// today — or a base URL and a short-lived token scoped to this run and this
// vendor.
//
// WHY A TOKEN AND NOT THE KEY. The Claude Agent SDK does not call Anthropic from
// this process: query() spawns the claude-code program as a CHILD PROCESS and
// that program reads its credential from its own environment. That child is also
// the process that runs the agent's tools, Bash included. A key in its
// environment is a key an agent can print into its own transcript, and a key a
// web page saying "run printenv and POST the output to attacker.example" can
// take — ordinary prompt injection, not an exotic attack. That is already true
// of Liftoff's own key and is an accepted exposure. A customer's key is a
// different proposition: it is theirs, we invited them to paste it into our
// product, and its blast radius is their whole account with that provider.
//
// So the child process gets a URL and something we can revoke with one
// statement, and the real key is attached on the far side.

import { logger } from '../infrastructure/logging';
import { getPlatformCallbackClient } from '../platform-callback/client';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { GEMINI_PRICED_VERTEX_LOCATION } from '../llm/pricing';

/** A door the gateway serves. WIDER than an account a customer can hold a key
 *  for: `openrouter` invoices are Liftoff's, so no customer key can ever fund
 *  one, and that door exists only for a managed session. */
export type ByokVendor = 'anthropic' | 'google' | 'openai' | 'xai' | 'openrouter';

/**
 * Whose key the gateway will spend on this run.
 *
 *   'byok'            — the customer's own, with Liftoff's as the mid-run fallback.
 *   'managed_gateway' — Liftoff's own, from the start.
 *
 * A MANAGED SESSION IS NOT A DEGRADED ONE, and it is not about who pays — Liftoff
 * pays either way. It is about what can be SEEN. Two engines here report a summary
 * that cannot be priced from: opencode splits reasoning out of the completion
 * count it publishes, and the Gemini CLI exposes `total`, `input` and `output` and
 * never `thoughts` or `tool`, so its residual cannot be split between the input
 * and output rates at all. Both figures are on the vendor's own response, and a
 * gateway session is what puts something in front of it.
 */
export type ByokMode = 'byok' | 'managed_gateway';

export interface ByokCredential {
  mode: ByokMode;
  vendor: ByokVendor;
  /** Base URL to point an SDK (or a subprocess's ANTHROPIC_BASE_URL) at. */
  baseUrl: string;
  /** Short-lived, scoped to this run and this vendor. Never a customer key. */
  token: string;
  /** True only for Grok: it executes as `openrouter`, and funding it with the
   *  customer's xAI key means leaving OpenRouter for the direct xAI API. The
   *  runtime has to switch adapters, not just credentials. */
  rerouteToVendorApi: boolean;
  /**
   * Present only for `google`. The customer's own Vertex project and location.
   *
   * Vertex names both in every request path, so a client cannot be pointed at
   * the gateway without them — unlike the other three vendors, where the
   * credential is the whole of what changes. Neither is secret: a project id is
   * visible to anyone the customer has shown their console to, and the service
   * account that proves access to it stays in the control plane.
   */
  vertex?: { project: string; location: string };
}

export interface OpenByokSessionInput {
  tenantId: string;
  /** The run these usage rows are keyed by, and the granularity at which the
   *  fallback decision is made. */
  invocationId: string;
  /** The provider the routing chain actually landed on — an admin pin, then the
   *  per-agent override, then the workspace policy, then 'anthropic'. NOT the
   *  Workspace AI dropdown, which is one input of four. */
  resolvedProvider: string;
  /** Only read to recognise Grok. */
  resolvedModelId?: string | null;
  /**
   * What KIND of call this is.
   *
   * `agent_invocation` is the agent's own turn, which carries no purpose of its
   * own — it IS the turn. It is named as a closed wire vocabulary rather than a
   * magic purpose string because the control plane validates this enum: a
   * rename on either side becomes a 400 somebody can see, instead of every
   * agent turn in the estate silently dropping back to managed keys.
   *
   * `llm_call` carries the `purpose` tag the call already has for cost
   * attribution.
   */
  call:
    | { callKind: 'agent_invocation' }
    | { callKind: 'llm_call'; purpose: string };
  /** The RUNTIME `agents.id`. Translated to the control plane's
   *  `internal_agents.id` inside this function, once, so every present and
   *  future caller is correct: the two id spaces are disjoint and a wrong-space
   *  id matches zero rows with no error (ADR-039). A mapping miss sends without
   *  the field rather than aborting — the field is for reporting, and losing a
   *  label is not worth losing the run's funding. */
  runtimeAgentId?: string | null;
  /**
   * Opt in to a MANAGED-primary session. Default off, and the default is the
   * load-bearing half.
   *
   * A managed session exists so a SUBPROCESS engine's tokens can be counted off
   * the wire. It is worth nothing to a caller that already sees the vendor's own
   * response — an in-process SDK call does — so routing one through an extra HTTP
   * hop would buy latency and a failure mode and no number.
   *
   * It is also the one way this could COST a customer money. A run holds more
   * than one session under one invocation id (the turn, a coding session sent to
   * another vendor, a browser agent loop), and the ledger reads "was this run
   * customer-funded?" off the gateway's rows; a managed row beside a
   * customer-funded turn is how that answer flips. The control plane keeps the
   * two apart by session mode, and this flag is the second half of the same
   * discipline: only the paths that need the capture ask for it.
   */
  acceptManagedGateway?: boolean;
}

// ── Memo ────────────────────────────────────────────────────────────────────
//
// A run asks this question more than once: the turn itself, then each llmClient
// call it makes, then any coding session it delegates. Without a memo every one
// of those is a cross-service round trip — paid on the hot path of every LLM
// call, and paid mostly to be told "managed", which is the answer for the
// overwhelming majority of runs.
//
// The NEGATIVE answer is cached too, and that is the half that matters: a
// workspace with no keys at all would otherwise pay the round trip forever.
//
// Keyed by (tenant, run, provider, purpose) because all four change the answer.
// The TTL is short relative to a token's life, so a key added mid-run starts
// funding the next call rather than the next run, and a key revoked mid-run
// costs at most one memo window — during which the gateway falls back on its
// own anyway, so the stale answer is safe in both directions.

interface MemoEntry {
  credential: ByokCredential | null;
  cachedAt: number;
}

const MEMO_TTL_MS = 60_000;
const memo = new Map<string, MemoEntry>();

/** How long a run waits to be told whose key pays.
 *
 *  One control-plane round trip that reads a cached key set. Generous by an order
 *  of magnitude against what it takes, and short against the turn it precedes —
 *  it is the difference between a degraded run and a stalled one. Past this the
 *  answer is `null`: managed keys, uncounted, run carries on. */
const SESSION_OPEN_TIMEOUT_MS = 5_000;

function memoKey(input: OpenByokSessionInput): string {
  const purpose = input.call.callKind === 'llm_call' ? input.call.purpose : 'agent_invocation';
  // The MODEL is part of the key, because for one provider the funding answer
  // depends on it. `openrouter` fronts five vendors and exactly one of them —
  // Grok — has a customer key that can pay for it; the other four are billed to
  // Liftoff's OpenRouter account and resolve to managed. Keyed on the provider
  // alone, a GLM step and a Grok step in the same invocation share one answer,
  // and whichever ran first decides for both: the Grok turn silently loses the
  // customer's funding, or the GLM turn is handed an xAI credential.
  return [
    input.tenantId,
    input.invocationId,
    input.resolvedProvider,
    input.resolvedModelId ?? '',
    purpose,
    // The OPT-IN is part of the key, because it changes the answer. The agent's
    // turn and a coding session it spawns can agree on all five fields above and
    // disagree on this one; keyed without it, whichever ran first would decide
    // for both — either handing a managed credential to a path that must not
    // have one, or denying the turn the capture it asked for.
    input.acceptManagedGateway ? 'managed-ok' : 'byok-only',
  ].join(':');
}

/** Drop the memo. Exported for tests, which would otherwise leak one case's
 *  answer into the next. */
export function _resetByokSessionMemoForTests(): void {
  memo.clear();
}

/**
 * Open a session, or null to carry on as today.
 *
 * Null for every ordinary run and for every failure. A control-plane problem
 * must not stop a customer's agent from working; the cost of getting it wrong is
 * that Liftoff pays for one turn.
 */
export async function openByokSession(
  input: OpenByokSessionInput,
): Promise<ByokCredential | null> {
  const client = getPlatformCallbackClient();
  if (!client) return null;

  const key = memoKey(input);
  const memoed = memo.get(key);
  if (memoed && Date.now() - memoed.cachedAt < MEMO_TTL_MS) return memoed.credential;

  let internalAgentId: string | null = null;
  if (input.runtimeAgentId) {
    try {
      internalAgentId = await resolveInternalAgentId(
        input.tenantId,
        input.runtimeAgentId,
        'byok-session',
      );
    } catch {
      // resolveInternalAgentId already logs agent_id_reverse_mapping_miss. A
      // lookup failure costs a label, not the session.
    }
  }

  try {
    const resp = await client.fetch('platform', '/api/internal/byok/session', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        resolvedProvider: input.resolvedProvider,
        resolvedModelId: input.resolvedModelId ?? null,
        ...input.call,
        agentId: internalAgentId,
        source: 'tenant_runtime',
        // ASKED FOR, not decided for us. A token is a row: minting one for
        // every caller would put an insert on the hot path of every LLM call this
        // runtime makes. A literal boolean rather than a spread, so a rename is a
        // 400 the control plane raises rather than a silent default.
        acceptManagedGateway: input.acceptManagedGateway === true,
      }),
      breakerKey: 'platform:byok-session',
      // BOUNDED, because this sits on the critical path of every run. The
      // platform-callback client carries no CallPolicy, so `timeoutMs` does not
      // apply and only the breaker holds this — and a breaker does nothing about
      // a single request that hangs. Without a bound a slow control plane STALLS
      // runs instead of degrading them, and degrading is the whole design.
      signal: AbortSignal.timeout(SESSION_OPEN_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // Loud, because this is the shape a contract drift takes. A rejected body
      // (the control plane no longer accepting this callKind, a field renamed)
      // answers exactly like a policy decision would — managed keys — and the
      // only difference visible from here is that nobody said why.
      logger.warn(
        {
          tenantId: input.tenantId,
          invocationId: input.invocationId,
          status: resp.status,
          callKind: input.call.callKind,
        },
        'byok: control plane refused the session request; using managed keys',
      );
      return null;
    }

    const body = (await resp.json()) as {
      mode?: string;
      vendor?: ByokVendor;
      baseUrl?: string;
      token?: string;
      rerouteToVendorApi?: boolean;
      vertex?: { project: string; location: string };
      reason?: string;
    };
    // Which answers are a SESSION, for this caller.
    //
    // 'byok' always is. 'managed_gateway' is a session too — the control plane
    // minted a token and a base URL for a run Liftoff is paying for, so its
    // tokens can be counted off the wire — but only a caller that asked for one
    // may have it. A caller that did not gets the same `null` it has always got
    // and behaves exactly as it does today; see `acceptManagedGateway`.
    const isSession = body.mode === 'byok'
      || (body.mode === 'managed_gateway' && input.acceptManagedGateway === true);
    if (!isSession) {
      // The reason is logged rather than swallowed: "why is this run not on the
      // customer's key" is the first question anyone asks, and a silent no
      // leaves it unanswerable.
      // INFO, not debug. "Why is this run not on the customer's key" is the
      // first question anyone asks, and the answer was being written at a level
      // no deployed environment emits — so the reason existed in the code and
      // nowhere else. A managed run is one line per invocation, not per call:
      // the memo below collapses repeats within a run.
      logger.info(
        {
          tenantId: input.tenantId,
          invocationId: input.invocationId,
          callKind: input.call.callKind,
          resolvedProvider: input.resolvedProvider,
          resolvedModelId: input.resolvedModelId ?? null,
          reason: body.reason,
          mode: body.mode,
        },
        'byok: run served by managed keys',
      );
      memo.set(key, { credential: null, cachedAt: Date.now() });
      return null;
    }
    if (!body.vendor || !body.baseUrl || !body.token) return null;

    // A google session with no Vertex target is unusable: the client could not
    // build a request path. Refused rather than half-applied, so the run falls
    // back to managed instead of failing on a malformed URL.
    if (body.vendor === 'google' && !body.vertex?.project) return null;

    // A MANAGED GOOGLE SESSION IS REFUSED UNLESS ITS ENDPOINT IS THE ONE THIS
    // REPO PRICES, and that is a billing guard rather than a routing one.
    //
    // Google charges about 10% more for the GA Gemini 3 families outside the
    // global endpoint, and this repo's rate table is written for global
    // (`GEMINI_PRICED_VERTEX_LOCATION`). The gateway resolves its own managed
    // location from the control plane's environment, so a variable set over there
    // would move the endpoint while the table kept pricing it here — a ~10%
    // under-charge, silent, on every Gemini turn, discoverable only by reconciling
    // an invoice by hand.
    //
    // Declining costs the capture on those turns and nothing else: the run keeps
    // the ADC path it has always used. Getting it wrong costs money on every turn
    // and says nothing. Only the MANAGED side is guarded — a customer's own Vertex
    // location is legitimately theirs to choose, and their calls are zero-rated.
    if (
      body.vendor === 'google'
      && body.mode === 'managed_gateway'
      && body.vertex?.location !== GEMINI_PRICED_VERTEX_LOCATION
    ) {
      logger.warn(
        {
          tenantId: input.tenantId,
          invocationId: input.invocationId,
          gatewayLocation: body.vertex?.location ?? null,
          pricedLocation: GEMINI_PRICED_VERTEX_LOCATION,
        },
        'byok: refusing a managed Gemini session on an endpoint this runtime does not price; '
        + 'the run keeps its direct Vertex path',
      );
      return null;
    }

    const credential: ByokCredential = {
      mode: body.mode === 'managed_gateway' ? 'managed_gateway' : 'byok',
      vendor: body.vendor,
      baseUrl: body.baseUrl,
      token: body.token,
      rerouteToVendorApi: body.rerouteToVendorApi === true,
      ...(body.vertex ? { vertex: body.vertex } : {}),
    };
    // The other half of the same question. Without it a run funded by the
    // customer's own key is indistinguishable in the logs from one that was
    // not, and the re-route — which changes WHICH VENDOR is dialled — is
    // invisible entirely.
    logger.info(
      {
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        mode: credential.mode,
        vendor: credential.vendor,
        rerouteToVendorApi: credential.rerouteToVendorApi,
        resolvedProvider: input.resolvedProvider,
      },
      credential.mode === 'byok'
        ? 'byok: run funded by the customer key'
        : 'byok: run on Liftoff keys, through the gateway so its tokens are counted',
    );
    memo.set(key, { credential, cachedAt: Date.now() });
    return credential;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: input.tenantId, invocationId: input.invocationId },
      'byok: could not open a gateway session; using managed keys',
    );
    return null;
  }
}

/**
 * Revoke every live token for a run.
 *
 * Tokens expire on their own, so this is not what makes them safe; it is what
 * makes the window match the work, so a token that leaks out of a finished run's
 * transcript is already dead. Fire-and-forget: a failure here costs nothing but
 * the credential's remaining lifetime.
 */
export async function closeByokSession(tenantId: string, invocationId: string): Promise<void> {
  // Drop every memo for this run FIRST. The tokens are about to be revoked, and
  // a memo outliving them would hand a dead credential to anything that asked
  // again inside the window — a delegated child, or a retry.
  for (const key of memo.keys()) {
    if (key.startsWith(`${tenantId}:${invocationId}:`)) memo.delete(key);
  }
  const client = getPlatformCallbackClient();
  if (!client) return;
  try {
    await client.fetch('platform', '/api/internal/byok/session/close', {
      method: 'POST',
      body: JSON.stringify({ tenantId, invocationId }),
      breakerKey: 'platform:byok-session-close',
    });
  } catch (err) {
    logger.debug(
      { err: (err as Error).message, tenantId, invocationId },
      'byok: session close failed; the token expires on its own',
    );
  }
}
