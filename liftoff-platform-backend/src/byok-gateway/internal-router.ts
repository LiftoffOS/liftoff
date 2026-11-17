// Service-to-service: the tenant runtime asking "whose key pays for this run,
// and how do I reach it".
//
// The runtime never sees a customer's provider key and never learns whether one
// exists beyond the answer to this one question. It gets back either "managed"
// — carry on exactly as you do today — or a base URL and a short-lived token
// scoped to that run and that vendor.
//
// Auth: PLATFORM_CALLBACK_TOKEN, the same shared TR→PB secret every other
// runtime callback validates. Mounted BEFORE the global authMiddleware.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { log } from '../infrastructure/logging';
import {
  AGENT_INVOCATION_PURPOSE,
  keyVendorForProvider,
  resolveByokCredential,
} from '../tenant-ai-provider-keys/resolution-service';
import { getKey } from '../tenant-ai-provider-keys/repository';
import { readProviderSecret } from '../tenant-ai-provider-keys/secret-storage';
import { DEFAULT_VERTEX_LOCATION } from '../tenant-ai-provider-keys/types';
import { canSubstituteManaged } from './managed-fallback';
import { mintGatewayToken, revokeRunTokens, type GatewayVendor } from './token-store';
import { sumGatewayUsageForRun } from './usage-recorder';
import { gatewayVendors } from './vendor-adapters';
import { OPENROUTER_HOSTED_PROVIDERS } from '../model-registry/workspace-ai-vendors';

export const byokGatewayInternalRouter = Router();
const svcAuth = verifyServiceAuth({ tokenEnvVar: 'PLATFORM_CALLBACK_TOKEN' });

const openSchema = z.intersection(
  z.object({
    tenantId: z.string().uuid(),
    /** The run this session belongs to. Every usage row the gateway writes is
     *  keyed by it, and it is the granularity the fallback decision has. */
    invocationId: z.string().min(1).max(200),
    /** The provider the routing chain actually landed on — an admin pin, then
     *  the per-agent override, then the workspace policy, then 'anthropic'. NOT
     *  the Workspace AI dropdown. */
    resolvedProvider: z.string().min(1).max(64),
    /** Only read to recognise Grok, which executes as openrouter but is
     *  fundable by an xAI key via the direct API. */
    resolvedModelId: z.string().max(200).nullable().optional(),
    agentId: z.string().uuid().nullable().optional(),
    /** The ingestion source classifyChargeability keys off. */
    source: z.enum(['tenant_runtime', 'platform_llm']).optional(),
    /**
     * Whether this caller can USE a managed-primary session.
     *
     * Asked on the wire rather than answered for every caller, because a token
     * is a row: minting one for a caller that will discard it puts an insert on
     * the hot path of every LLM call the runtime makes and fills
     * `byok_gateway_tokens` with credentials nobody ever presents.
     *
     * Default false, and the default is the load-bearing half. A managed session
     * is worth nothing to a caller that already reads the vendor's own response
     * — an in-process SDK call does — and it is the one way this change could
     * cost a customer money: a run holds more than one session under one
     * invocation id, and a managed row landing beside a genuinely
     * customer-funded turn is what `session_mode` exists to keep apart. Only the
     * paths that need the capture ask for it.
     */
    acceptManagedGateway: z.boolean().optional(),
  }),
  // What KIND of call this is, rather than a purpose string for every case.
  //
  // The agent's own turn carries no purpose of its own — it IS the turn — and
  // naming it on the wire as a magic purpose meant two services holding the
  // same literal with nothing checking they agreed. A rename on this side would
  // have silently moved every agent turn in the estate onto managed keys, which
  // is the "wired at one end" failure with a bill attached.
  //
  // So the wire carries a CLOSED vocabulary that zod enforces, and the sentinel
  // purpose exists in exactly one place — the resolver, on this side. A caller
  // that sends something else gets a 400 it can see, not a silent decline.
  z.discriminatedUnion('callKind', [
    z.object({ callKind: z.literal('agent_invocation') }),
    z.object({
      callKind: z.literal('llm_call'),
      /** The `purpose` tag the call already carries for cost attribution. */
      purpose: z.string().min(1).max(120),
    }),
  ]),
);

const closeSchema = z.object({
  tenantId: z.string().uuid(),
  invocationId: z.string().min(1).max(200),
});

// POST /session — open a gateway session for one run.
byokGatewayInternalRouter.post('/session', svcAuth, async (req: Request, res: Response) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    return;
  }
  const input = parsed.data;
  // The one place the adapter path's sentinel is named. Nothing off-process
  // holds this string.
  const purpose = input.callKind === 'agent_invocation'
    ? AGENT_INVOCATION_PURPOSE
    : input.purpose;

  try {
    const resolution = await resolveByokCredential({
      tenantId: input.tenantId,
      resolvedProvider: input.resolvedProvider,
      resolvedModelId: input.resolvedModelId ?? null,
      purpose,
      agentId: input.agentId ?? null,
      source: input.source,
    });

    if (resolution.mode === 'managed') {
      // A MANAGED RUN STILL GOES THROUGH THE DOOR, when the door can serve it
      // and the caller asked. Not for the money — Liftoff pays either way — but
      // so something reads the vendor's own response, which is where two of the
      // engines this platform runs keep the only figure that can be priced.
      //
      // Nothing about serving it is new: minting, verifying and forwarding never
      // required a customer key to exist, and `served_by` has always accepted
      // 'managed' for the mid-run fallback. Only the credential attached on the
      // far side differs, which is already a per-request decision.
      //
      // The reason travels back either way, so the runtime can log WHY a run it
      // expected to be BYOK-funded is not. Without it the answer is a silent
      // "no" and the first question anyone asks is unanswerable.
      const managed = input.acceptManagedGateway === true
        ? await openManagedSession(input, purpose)
        : null;
      res.json({
        ...(managed ?? { mode: 'managed' }),
        reason: resolution.reason,
      });
      return;
    }

    // The resolver decides whose key SHOULD pay; the gateway decides what it can
    // actually serve. A vendor with no adapter here would get a token nothing
    // can spend, and the ledger would read the run as unfunded — so answer
    // managed instead, which is what will really happen.
    if (!gatewayVendors().includes(resolution.vendor)) {
      log.warn(
        { vendor: resolution.vendor, tenantId: input.tenantId },
        'byok: resolver picked a vendor the gateway has no adapter for; serving managed',
      );
      res.json({ mode: 'managed', reason: 'provider_not_fundable' });
      return;
    }

    const minted = await mintGatewayToken({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      vendor: resolution.vendor,
      agentId: input.agentId ?? null,
      purpose,
      mode: 'byok',
    });

    // Vertex names the project and location in every request path, so a caller
    // building a Vertex client has to know the customer's. Neither is a secret
    // — a GCP project id is visible to anyone the customer has shown their
    // console to — and the credential that proves access to them stays here.
    const vertex = resolution.vendor === 'google'
      ? await describeVertexTarget(input.tenantId)
      : null;

    res.json({
      mode: 'byok',
      vendor: resolution.vendor,
      ...(vertex ? { vertex } : {}),
      // What goes into the subprocess's ANTHROPIC_BASE_URL (or the SDK client's
      // baseURL). The real key is never part of this response.
      baseUrl: `${getBackendUrl()}/byok/${resolution.vendor}`,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      // True only for Grok: it executes as openrouter, and funding it with the
      // customer's xAI key means leaving OpenRouter for the direct xAI API. The
      // runtime has to switch adapters, not just credentials.
      rerouteToVendorApi: resolution.rerouteToVendorApi,
    });
  } catch (error) {
    log.error(
      {
        event: 'byok_session_open_failed',
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        error: (error as Error).message,
      },
      'BYOK gateway session could not be opened',
    );
    // Degrade to managed rather than failing the run. A control-plane hiccup
    // must not stop a customer's agent from working; the cost of getting this
    // wrong is that Liftoff pays for one turn.
    //
    // The reason is its own value rather than one of the resolver's: "we could
    // not answer" is not the same as any of the answers, and reporting it as one
    // would make an outage read like a policy decision in the runtime's logs.
    res.json({ mode: 'managed', reason: 'session_open_failed' });
  }
});

type OpenSessionInput = z.infer<typeof openSchema>;

/**
 * Which gateway door serves a run that Liftoff's own key is paying for.
 *
 * NOT `keyVendorForProvider` alone, and the difference is the whole of what a
 * managed session adds. That function answers "which customer ACCOUNT could
 * settle this invoice", so it is null for every family reached through
 * OpenRouter — correctly, because an OpenRouter invoice is ours. A managed
 * session is asking a different question: "which wire does this request go out
 * on". GLM, Qwen, DeepSeek, Kimi, MiniMax and Xiaomi all go out on OpenRouter's,
 * and that is where their reasoning tokens are reported.
 *
 * Null for a provider with no door — `anthropic-vertex` over ADC has no API key
 * in the path to substitute — and the caller then answers plain managed, which is
 * exactly what happens today.
 */
function managedGatewayVendor(resolvedProvider: string): GatewayVendor | null {
  const keyVendor = keyVendorForProvider(resolvedProvider);
  if (keyVendor) return keyVendor;
  if (
    resolvedProvider === 'openrouter'
    || OPENROUTER_HOSTED_PROVIDERS.includes(resolvedProvider)
  ) {
    return 'openrouter';
  }
  return null;
}

/**
 * Mint a managed-primary session, or null to leave the run exactly as it is.
 *
 * Null for three reasons and none of them is a failure: the provider has no door
 * (`managedGatewayVendor`), the gateway has no adapter for the door, or the
 * substitution cannot be made right now — Google with no `GCP_PROJECT_ID`, xAI
 * with no OpenRouter key on file. That last check is the one worth stating:
 * without it the runtime would be handed a base URL and a token, point its engine
 * at them, and get a 502 for a turn that had a perfectly good managed path of its
 * own. A door that cannot open is not offered.
 *
 * Never throws. Its caller is already inside a try that degrades to managed, and
 * a managed session that could not be opened has to degrade to the SAME answer —
 * the run carries on, uncounted, which is what it does today.
 */
async function openManagedSession(
  input: OpenSessionInput,
  purpose: string,
): Promise<{
  mode: 'managed_gateway';
  vendor: GatewayVendor;
  baseUrl: string;
  token: string;
  expiresAt: string;
  rerouteToVendorApi: false;
  vertex?: { project: string; location: string };
} | null> {
  const vendor = managedGatewayVendor(input.resolvedProvider);
  if (!vendor) return null;
  if (!gatewayVendors().includes(vendor)) return null;
  if (!(await canSubstituteManaged(vendor, purpose))) {
    log.info(
      { vendor, tenantId: input.tenantId, invocationId: input.invocationId },
      'byok: no managed substitution available for this vendor; leaving the run on its direct path',
    );
    return null;
  }

  try {
    const minted = await mintGatewayToken({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      vendor,
      agentId: input.agentId ?? null,
      purpose,
      mode: 'managed',
    });
    return {
      mode: 'managed_gateway',
      vendor,
      baseUrl: `${getBackendUrl()}/byok/${vendor}`,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      // Only ever true for a customer's xAI key funding a Grok run booked under
      // OpenRouter. A managed run has nothing to re-route TO: Liftoff's own
      // account is the one the resolved provider already names.
      rerouteToVendorApi: false,
      // Liftoff's OWN project and location, which is what the managed
      // substitution rewrites the path to anyway. Sent because a Vertex client
      // cannot build a request path without them, and a client pointed at the
      // gateway with the wrong pair would have its path rewritten under it.
      ...(vendor === 'google' ? { vertex: managedVertexTarget() } : {}),
    };
  } catch (error) {
    log.warn(
      {
        event: 'byok_managed_session_open_failed',
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        vendor,
        error: (error as Error).message,
      },
      'BYOK gateway could not open a managed session; the run keeps its direct path',
    );
    return null;
  }
}

/** Liftoff's own Vertex project and location — the same pair
 *  `getManagedSubstitution` rewrites a request path to, read from the same
 *  environment in the same precedence, so the two cannot name different
 *  projects.
 *
 *  `canSubstituteManaged` has already established the project is set, so the
 *  empty string is not expected. It is not a silent failure if it happens: the
 *  runtime refuses a google session whose `vertex.project` is empty and keeps its
 *  direct ADC path, which is the same answer as no session at all. */
function managedVertexTarget(): { project: string; location: string } {
  return {
    project: process.env.GCP_PROJECT_ID ?? '',
    location: process.env.GCP_LOCATION
      ?? process.env.VERTEX_LOCATION
      ?? DEFAULT_VERTEX_LOCATION,
  };
}

/**
 * The customer's own Vertex project and location, for a caller that has to build
 * a Vertex client pointed at the gateway.
 *
 * Read from the stored credential rather than carried on the request, so a
 * runtime cannot name a project it was not given. Null when the credential
 * cannot be read, which the caller treats the same way it treats no key at all.
 */
async function describeVertexTarget(
  tenantId: string,
): Promise<{ project: string; location: string } | null> {
  const stored = await getKey(tenantId, 'google');
  if (!stored) return null;
  const credential = await readProviderSecret(stored.secretName);
  if (credential?.kind !== 'vertex_service_account') return null;
  return { project: credential.project, location: credential.location };
}

// POST /session/close — revoke every live token for a run.
//
// Called when the run ends. Tokens expire on their own, so this is not what
// makes them safe; it is what makes the window match the work, so a token that
// leaks out of a finished run's transcript is already dead.
byokGatewayInternalRouter.post('/session/close', svcAuth, async (req: Request, res: Response) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    return;
  }
  try {
    const revoked = await revokeRunTokens(parsed.data.tenantId, parsed.data.invocationId);
    res.json({ revoked });
  } catch (error) {
    log.warn(
      {
        tenantId: parsed.data.tenantId,
        invocationId: parsed.data.invocationId,
        error: (error as Error).message,
      },
      'BYOK gateway session close failed',
    );
    res.status(500).json({ error: 'close_failed' });
  }
});

// GET /session/usage — what the gateway saw on the wire for one run.
//
// THIS IS WHAT MAKES THE CAPTURE BILLABLE. The gateway is the only component
// that reads the vendor's own response, and two of the engines the runtime drives
// report a summary that cannot be priced from.
//
// One endpoint and NO second billing path. The runtime reads this at the end of
// its turn and prefers it over the engine's self-report, exactly as it already
// prefers a vendor-reported charge over a rate-table estimate; the invocation
// stays the single billing record, so there is no double-charge risk and nothing
// changes in the dedup logic.
//
// `tenantId` is required and is not a formality: these rows are RLS-scoped and
// the sum is read under that tenant's scope. A run id alone would be a
// cross-tenant read waiting for a caller to make it.
const usageQuerySchema = z.object({
  tenantId: z.string().uuid(),
  invocationId: z.string().min(1).max(200),
  /**
   * Only the requests served at or after this instant.
   *
   * The caller's own HALF, not the whole run, and that is the difference between
   * correcting a charge and duplicating one. A turn that pauses for a person
   * bills the paused half and then bills its continuation separately, while every
   * gateway row for both halves is written under the run's own id — so an
   * unbounded sum handed to the continuation contains requests the paused half
   * has already been charged for.
   *
   * Optional, because a run that bills once has nothing to bound.
   */
  since: z.string().datetime().optional(),
});

byokGatewayInternalRouter.get('/session/usage', svcAuth, async (req: Request, res: Response) => {
  const parsed = usageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    return;
  }
  try {
    const usage = await sumGatewayUsageForRun(
      parsed.data.tenantId,
      parsed.data.invocationId,
      parsed.data.since ? new Date(parsed.data.since) : undefined,
    );
    res.json(usage);
  } catch (error) {
    log.warn(
      {
        event: 'byok_session_usage_read_failed',
        tenantId: parsed.data.tenantId,
        invocationId: parsed.data.invocationId,
        error: (error as Error).message,
      },
      'BYOK gateway usage could not be read for a run',
    );
    // 503 rather than an empty sum. A caller that read zeroes would take them for
    // "the gateway saw nothing" and keep the engine's numbers — which is the
    // right behaviour for a run that never came through the door and the WRONG
    // one for a run whose figures we simply failed to read. Saying so lets the
    // caller keep the engine's numbers knowingly.
    res.status(503).json({ error: 'usage_read_failed' });
  }
});
