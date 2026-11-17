// Tool Gateway REST router.
//
// Mount at `/api/v1` in src/index.ts. The resource surface:
//
//   POST   /tool-calls                              — execute a tool call (201)
//   POST   /tool-calls/batch                        — execute a batch (201)
//   POST   /tool-calls/guard                        — run the pre-dispatch
//                                                     guard chain for a caller
//                                                     that dispatches itself
//   POST   /tool-calls/guard-external               — judge a vendor-SDK write
//                                                     BEFORE it dispatches
//   POST   /tool-calls/observe-external             — record what a vendor-SDK
//                                                     call returned
//   POST   /tool-calls/self-dispatched              — action-ledger row for a
//                                                     call the caller dispatched
//   GET    /conflict-policies/{connector}/{entityType}/{actionType}
//                                                   — look up conflict policy
//   POST   /a2a/rpc                                 — external-agent JSON-RPC
//                                                     (RPC by protocol spec)
//
// Phase 4: when SERVICE_TYPE=tool-gateway, this is the sole surface; in
// monolith mode these routes live alongside the others. Auth accepts either
// a Google OIDC bearer (minted by the caller's Cloud Run metadata server,
// aud == TOOL_GATEWAY_SERVICE_URL) or the shared X-Service-Auth bearer.

import { Router } from 'express';
import { ToolGatewayService } from './service';
import { externalAgentHandler } from './external-agent-handler';
import { requireServiceAuth } from '../security/service-auth';
import { AdmissionDeniedError } from '../admission/types';

export const toolGatewayRouter = Router();
/**
 * Singleton — exported so index.ts can inject the SandboxExecutor at bootstrap
 * via `toolGatewayService.setSandboxExecutor(...)`. All routes share this
 * instance.
 */
export const toolGatewayService = new ToolGatewayService();
const service = toolGatewayService;

function resolveTenantRuntimeSaEmail(): string[] {
  const tenantId = process.env.TENANT_ID;
  const env = process.env.ENVIRONMENT;
  if (!tenantId || !env) return [];
  return [`tenant-${tenantId}-runtime@tenant-${tenantId}-${env}.iam.gserviceaccount.com`];
}

function resolveOidcAudience(): string | undefined {
  const url = process.env.TOOL_GATEWAY_SERVICE_URL?.trim();
  return url && url.length > 0 ? url : undefined;
}

const auth = requireServiceAuth({
  acceptOidc: true,
  oidcAudience: () => resolveOidcAudience() ?? '',
  allowedOidcEmails: resolveTenantRuntimeSaEmail,
});

// -----------------------------------------------------------------------------
// /tool-calls
// -----------------------------------------------------------------------------
// A tool call is a single authenticated connector action. POST creates one
// and returns the execute result. `_internalSkipHitl` is stripped at the
// HTTP boundary — only in-process MCP code can set it (SE-002).

toolGatewayRouter.post('/tool-calls', auth, async (req, res, next) => {
  const { _internalSkipHitl, ...safeInput } = req.body ?? {};
  void _internalSkipHitl;
  try {
    const result = await service.execute(safeInput);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AdmissionDeniedError) {
      // A denial is a policy answer, not a fault: 403 with the reason in the
      // body, never a 500 the caller reads as an outage. Every admission path
      // (connector, sandbox, workflow) throws this type, which is why there is
      // no longer a message-prefix branch for `Action admission denied:` —
      // matching prose to recover a classification was the failure mode.
      res.status(403).json({
        error: err.message,
        code: err.code,
        reason: err.reason,
        quotaType: err.quotaType,
      });
    } else if (err instanceof Error && err.message.startsWith('Governance authorize denied:')) {
      res.status(403).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

// The guard chain, for a caller that dispatches to the vendor ITSELF.
//
// `_internalSkipHitl` is stripped here as it is on /tool-calls: a caller must
// not be able to skip oversight by asking. The guards this runs are the ones
// `execute` runs, and they live here because the provenance store does — a
// caller evaluating them locally would judge a write against a store that never
// saw the run's reads.
toolGatewayRouter.post('/tool-calls/guard', auth, async (req, res, next) => {
  const { _internalSkipHitl, ...input } = (req.body ?? {}) as Record<string, unknown>;
  void _internalSkipHitl;
  try {
    const refusal = await service.preDispatchGuards(
      input as unknown as Parameters<typeof service.preDispatchGuards>[0],
    );
    res.status(200).json({ refusal: refusal ?? null });
  } catch (err) {
    if (err instanceof AdmissionDeniedError) {
      res.status(403).json({ error: err.message, code: err.code, reason: err.reason, quotaType: err.quotaType });
      return;
    }
    next(err);
  }
});

// One write the vendor SDK is about to dispatch without us. Judged HERE, before
// it runs, in the process that owns the store — and this is the one seam where a
// direct-dispatch write can be refused.
toolGatewayRouter.post('/tool-calls/guard-external', auth, async (req, res, next) => {
  try {
    const hold = await service.guardExternal(
      (req.body ?? {}) as Parameters<typeof service.guardExternal>[0],
    );
    res.status(200).json({ hold: hold ?? null });
  } catch (err) {
    next(err);
  }
});

// One tool call that reached its vendor without us — a vendor-hosted MCP server
// the engine talked to directly. Recorded HERE so it lands in the same store the
// guards read.
toolGatewayRouter.post('/tool-calls/observe-external', auth, async (req, res, next) => {
  try {
    const recorded = await service.observeExternal(
      (req.body ?? {}) as Parameters<typeof service.observeExternal>[0],
    );
    res.json({ recorded });
  } catch (err) {
    next(err);
  }
});

// The action-ledger row for a call the CALLER dispatched — the Composio route.
// Written here because the ledger is this service's, and because the row must be
// the one `backstopLedger` writes rather than a second, similar one.
toolGatewayRouter.post('/tool-calls/self-dispatched', auth, async (req, res, next) => {
  const body = (req.body ?? {}) as { input?: Record<string, unknown>; result?: Record<string, unknown> };
  if (!body.input || !body.result) {
    res.status(400).json({ error: 'Request body must contain `input` and `result`' });
    return;
  }
  const { _internalSkipHitl, ...input } = body.input;
  void _internalSkipHitl;
  try {
    const record = await service.recordSelfDispatched(
      input as unknown as Parameters<typeof service.recordSelfDispatched>[0],
      body.result as unknown as Parameters<typeof service.recordSelfDispatched>[1],
    );
    // The host note, when the recorder attached one, goes back by value: the
    // caller's copy of the result lives in another process.
    res.status(200).json(record);
  } catch (err) {
    next(err);
  }
});

// A staged apply the caller dispatched itself has to settle its batch HERE,
// where the batch store is: the vendor's answer recorded on the claimed batch,
// or the claim handed back on failure (staged-batches.ts).
toolGatewayRouter.post('/tool-calls/staged-apply-settle', auth, async (req, res, next) => {
  const body = (req.body ?? {}) as { input?: Record<string, unknown>; outcome?: { success: boolean; data?: unknown; error?: string } };
  if (!body.input || !body.outcome) {
    res.status(400).json({ error: 'Request body must contain `input` and `outcome`' });
    return;
  }
  const { _internalSkipHitl, ...input } = body.input;
  void _internalSkipHitl;
  try {
    await service.settleStagedApply(
      input as unknown as Parameters<typeof service.settleStagedApply>[0],
      body.outcome,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

toolGatewayRouter.post('/tool-calls/batch', auth, async (req, res, next) => {
  const body = req.body as { items?: Array<Record<string, unknown>> };
  if (!Array.isArray(body?.items)) {
    res.status(400).json({ error: 'Request body must contain an `items` array' });
    return;
  }
  const safeInputs = body.items.map(({ _internalSkipHitl, ...rest }) => {
    void _internalSkipHitl;
    return rest;
  }) as unknown as Parameters<typeof service.executeBatch>[0];
  try {
    const results = await service.executeBatch(safeInputs);
    res.status(201).json({ items: results });
  } catch (err) {
    // Per-item admission denials come back INSIDE the results array as failed
    // items; a throw out of executeBatch means the whole batch was refused, and
    // that is still a policy answer rather than a fault.
    if (err instanceof AdmissionDeniedError) {
      res.status(403).json({
        error: err.message,
        code: err.code,
        reason: err.reason,
        quotaType: err.quotaType,
      });
      return;
    }
    next(err);
  }
});

// -----------------------------------------------------------------------------
// /conflict-policies/{connector}/{entityType}/{actionType}
// -----------------------------------------------------------------------------
// Conflict policies are keyed by the (connector, entityType, actionType)
// triple. A missing policy returns null (200) rather than 404 because callers
// often treat "no explicit policy" as a distinct value; they never need to
// distinguish missing-policy from missing-route.

toolGatewayRouter.get(
  '/conflict-policies/:connector/:entityType/:actionType',
  auth,
  async (req, res, next) => {
    try {
      const policy = await service.getConflictPolicy(
        req.params.connector,
        req.params.entityType,
        req.params.actionType,
      );
      res.json(policy);
    } catch (err) {
      next(err);
    }
  },
);

// -----------------------------------------------------------------------------
// /a2a/rpc  (JSON-RPC 2.0)
// -----------------------------------------------------------------------------
// External agents invoke internal agents through this single endpoint. JSON-RPC
// owns its own envelope (`jsonrpc`, `id`, `method`, `params`, `result`, `error`)
// which does not round-trip cleanly through REST — the endpoint stays as a
// protocol-style RPC handler. Auth is separate: tenant-scoped user JWT + the
// external-agent-id header, enforced inside externalAgentHandler.

toolGatewayRouter.post('/a2a/rpc', async (req, res, next) => {
  const externalAgentId = req.headers['x-external-agent-id'] as string;
  const authHeader = req.headers['authorization'] as string;
  const tenantId = req.headers['x-tenant-id'] as string;

  if (!externalAgentId || !tenantId) {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Missing required headers' },
    });
  }

  const { teamId, toolName, toolInput, requestId } = req.body ?? {};

  try {
    const result = await externalAgentHandler.executeInbound({
      externalAgentId,
      tenantId,
      teamId,
      toolName,
      toolInput,
      authHeader,
      requestId,
    });

    res.json({
      jsonrpc: '2.0',
      id: requestId,
      result: result.success ? result.data : undefined,
      error: result.error ? { code: -32000, message: result.error } : undefined,
    });
  } catch (err) {
    next(err);
  }
});
