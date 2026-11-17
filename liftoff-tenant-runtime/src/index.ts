// Liftoff Tenant Runtime - Execution Plane
// Per Section 1: The tenant runtime owns execution truth
//
// This process supports six operating modes, selected by the `SERVICE_TYPE`
// env var. A single Docker image boots any of them — each Cloud Run service
// deployment sets a different value:
//
//   - SERVICE_TYPE=monolith         — all routes + all background jobs (legacy
//                                     fallback; preserves the original
//                                     tenant-runtime single-process layout)
//   - SERVICE_TYPE=agent            — invocation surface (chat, threads, tasks,
//                                     execution, lifecycle, HITL, ledgers)
//   - SERVICE_TYPE=coordinator      — orchestration + control-plane subscribers
//   - SERVICE_TYPE=tool-gateway     — tool routing, connector proxy, catalog
//   - SERVICE_TYPE=reflection       — reflection engine (heavy, low concurrency)
//   - SERVICE_TYPE=sandbox-executor — sandbox provider + executor + alive ticker
//
// The five split services are the production topology. Monolith stays in the
// enum as a fallback but is not deployed.

import express, { Request, Response, NextFunction } from 'express';
import { tenantApiRouter } from './tenant-api/router';
import { coordinatorRouter } from './coordinator/router';
import { agentLifecycleRouter } from './agent-lifecycle/router';
import { syncStateRouter } from './agent-lifecycle/sync-state-router';
import { toolGatewayRouter } from './tool-gateway/router';
import { actionLedgerRouter } from './action-ledger/router';
import { usageLedgerRouter } from './usage-ledger/router';
import { webToolsDiagnosticRouter } from './integrations/web-fetch/diagnostic-router';
import { startWebFetchJanitor } from './integrations/web-fetch/janitor';
import { startLearnedShapeFlush, stopLearnedShapeFlush } from './tool-gateway/learned-shapes-flush';
import { getReleaseEmitter, shutdownNotifier } from './integrations/web-fetch/notifier';
import { evaluationsRouter } from './reflection-engine/router';
import { connectorsRouter } from './connectors/router';
import { agentExecutionRouter } from './agent-execution/router';
import { rerunRouter } from './agent-execution/rerun-router';
import { cloudTasksHandler } from './handlers/cloud-tasks-handler';
import { wakeOperatorInternalRouter } from './scheduling/wake-operator-internal-router';
import { standaloneTasksHandler } from './handlers/standalone-tasks-handler';
import { scheduledInvokeHandler } from './handlers/scheduled-invoke-handler';
import canaryRouter from './handlers/canary-router';
import { SUBSCRIBED_EVENTS } from './events/subscriber';
import { buildPushHandlerRouter } from './events/push-handler';
import { eventStatusRouter } from './events/event-status-router';
import { walKeysRouter } from './governance/wal-keys-router';
import { modelConfigResyncRouter } from './events/model-config-resync-router';
import providerSwitchRouter from './memory/provider-switch-router';
import { startEventTriggerSubscriber } from './scheduling/event-trigger';
// Phase 3 governance-engine integration (see src/governance/).
import { getGovernanceServiceMode } from './governance/governance-service-flag';
import { startWalDrainer } from './governance/wal-drainer';
import { startGovernanceEventsSubscriber } from './governance/governance-events-subscriber';
import { logger } from './infrastructure/logging';
import { initTelemetry, shutdownTelemetry } from './infrastructure/telemetry';
import { warmPools, getPoolStats } from './infrastructure/database';
import { migrateAllAgentSchedulerJobs } from './scheduling/cloud-scheduler';
import { validateRegistryAtStartupOrThrow } from './connectors/registry-validator';
import { initToolSchemaCache } from './connectors/tool-schema-cache';
import { startShapeProposalReport } from './tool-gateway/shape-proposals';
import { loadSecretsToEnv } from './infrastructure/secrets';
import { traceContextMiddleware } from './middleware/trace-context-middleware';
import { createKillSwitchMiddleware } from './middleware/kill-switch-middleware';
import { metricsRouter } from './infrastructure/metrics-router';
import { jobsRouter } from './jobs/router';
import { auditRouter } from './audit/router';
import { memoryRouter } from './memory/router';
import { invocationsRouter, threadsRouter } from './invocations';
import { streamingRouter } from './streaming';
import { hitlRouter } from './hitl-enforcement';
import { toolCatalogRouter } from './tool-catalog/router';
// Per implementation plan Phase 5.3: Research scheduler
import { startResearchScheduler } from './scheduling/research-scheduler';
import { initLLMUsageTracking } from './llm/usage-tracker';
import { reapStaleWorkspaces, reapStaleChatWorkspaces } from './agent-execution/engine/workspace-reaper';
// R5 wiring
import { pollSchemaUntilReady, isSchemaReady, probeSchema } from './startup/schema-check';
import { installProcessScrubbers, scrubLogger } from './observability/scrub-logger';
import { loadFramerSecret } from './workspace/untrusted-content-wrapper';
import { drainController } from './interactive-chat/sigterm-handler';
import { logMemorySample, startMemoryMonitor, stopMemoryMonitor } from './observability/memory-monitor';
import { setTenantPatternsPool } from './workspace/secret-scrubber';
import { getPoolForService } from './infrastructure/database';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
// Interactive chat routers — imported at top (Phase 4) so the route-map can
// reference them synchronously. Previously imported inline at mount site.
import { interactiveChatRouter } from './interactive-chat/tool-proxy-router';
import { chatTurnRouter } from './interactive-chat/chat-turn-handler';
import { testHarnessRouter } from './test-harness/run-agent-router';
import { loopRouter } from './execution-environments/loop-router';
import { skillsRouter } from './skills/router';
// R5 Fix 9: workspace-delete router factory (built after secrets hydrate).
import { buildWorkspaceDeleteRouter } from './interactive-chat/workspace-delete-router';
// Outbox worker: delivers control_plane_outbox rows to platform-backend.
import { startOutboxWorker } from './audit/outbox-worker';
import { startEnumerationScheduler, stopEnumerationScheduler } from './connector-replica/enumeration-scheduler';
import { startOutboxDrainer, stopOutboxDrainer } from './integrations/web-fetch/deep-research-outbox';
import { startActionTrustOutboxDrainer } from './hitl-enforcement/action-trust-outbox';
import { startReconciler,    stopReconciler    } from './integrations/web-fetch/deep-research-reconciler';
// Connector content — hybrid retrieval index (internal API).
import { connectorContentRouter } from './connector-content/router';
import { undoRouter } from './tool-gateway/undo-router';
import { dataLandscapeRouter } from './connector-replica/router';
import { provenanceRouter } from './provenance/router';
// TenantRuntimeService — Connect-RPC server for platform-backend communication.
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import registerTenantRuntimeService from './rpc/tenant-runtime-service';
// PR2: BrowserSessionsService — dashboard surface for Anchor browser sessions.
import registerBrowserSessionsService, { browserSessionsErrorInterceptor } from './browser-sessions/service';
// PR2: Anchor webhook receiver (HMAC-verified, raw-body parser).
import { anchorWebhookRouter } from './integrations/web-fetch/anchor-webhook-router';

// -----------------------------------------------------------------------------
// Phase 4: SERVICE_TYPE router gate
// -----------------------------------------------------------------------------
// A single Docker image supports five modes. Unknown values exit(1) before
// the listener binds so Cloud Run keeps the previous revision in service.
import { ownershipFor, resolveServiceType } from './service-type';

const resolvedServiceType = resolveServiceType(process.env.SERVICE_TYPE);
if (resolvedServiceType === null) {
  logger.error({ SERVICE_TYPE: process.env.SERVICE_TYPE }, 'Unknown SERVICE_TYPE — refusing to start');
  process.exit(1);
}
const SERVICE_TYPE = resolvedServiceType;

// Metric label discipline. A metric declared with a per-tenant or per-agent
// label does not just become unqueryable — incCounter's process-local
// accumulator is keyed on the label set and never evicted, so the instance leaks
// memory for as long as it runs. Checked here, alongside the other boot guards,
// so the revision fails its health check and Cloud Run keeps the previous one in
// service rather than rolling out a slow leak.
import { assertMetricLabelDiscipline } from './memory/metric-labels';

try {
  assertMetricLabelDiscipline();
} catch (err) {
  logger.error({ err: (err as Error).message }, 'Metric label discipline violated — refusing to start');
  process.exit(1);
}

// Startup guard (plan §4.4): fail the Cloud Run revision health-check BEFORE
// the listener binds if a required env var is missing. Cloud Run rolls back to
// the previous Ready revision, CD pipeline reports failure. This is safe to
// run on every boot because Phase 4.7 (single-phase deploy) burns every peer
// URL into the initial --set-env-vars — there is no longer a window during
// which the service runs without TENANT_RUNTIME_URL.
//
// A two-phase deploy (deploy, then wire peer URLs) briefly runs without
// TENANT_RUNTIME_URL and would trip this guard; the single-phase deploy closes
// that window.
import { tenantRuntimeUrlState } from './infrastructure/runtime-env';
import { getManagedSecret } from './infrastructure/secret-store';

const REQUIRES_TENANT_RUNTIME_URL: ReadonlyArray<string> = ['monolith', 'agent', 'coordinator', 'tool-gateway'];
if (REQUIRES_TENANT_RUNTIME_URL.includes(SERVICE_TYPE)) {
  const state = tenantRuntimeUrlState();
  if (state === 'missing' || state === 'malformed') {
    logger.error({ SERVICE_TYPE, state }, 'TENANT_RUNTIME_URL required and not set/malformed — refusing to start');
    process.exit(1);
  }
  if (state === 'placeholder') {
    // First-ever deploy: cloudbuild's resolve-peer-urls step found no existing
    // peer URLs (services don't exist yet), so the deploy step burned a
    // placeholder into the initial revision env. The patch-split-service-urls
    // step is about to fire (waitFor: deploy-*-service) and create a NEW
    // revision with real peer URLs. Boot now so the deploy step succeeds;
    // getTenantRuntimeUrl() will throw if anything tries to USE the URL
    // during this brief window — no events should be flowing on a tenant
    // project's first deploy.
    logger.warn({ SERVICE_TYPE }, 'TENANT_RUNTIME_URL is the first-deploy placeholder — booting; patch-split-service-urls should land within ~60s');
  }
}
const {
  ownsAgentRoutes,
  ownsCoordinatorRoutes,
  ownsToolGatewayRoutes,
  ownsReflectionRoutes,
  ownsSandboxExecutor,
} = ownershipFor(SERVICE_TYPE);

// The Claude Agent SDK registers process exit listeners (subprocess
// cleanup wiring) on each query() call without explicitly removing them
// when the call completes. Under sustained load (e.g. a 36-scenario
// harness suite hitting one instance), this accumulates fast and Node
// emits MaxListenersExceededWarning at the default cap of 10. The
// warning itself is benign but indicates an upstream SDK leak we can't
// fix from here. Bump the cap so the warning doesn't pollute logs and
// confuse triage. The real listeners are exit-event handlers (fire
// once on process termination); they cost a few bytes each in the
// listener array, not memory in any meaningful sense — the OOM that
// motivated the container memory bump (cloudbuild.yaml: 2Gi → 4Gi) was
// driven by accumulated SDK subprocess state, not by these listeners.
process.setMaxListeners(50);

const app = express();
// PR2: Anchor webhook router uses per-route express.raw() so the HMAC
// verifier can read the unmodified body. Mount BEFORE the global JSON
// parser as a safety belt.
app.use(anchorWebhookRouter);
// Coordinator checkpoint POSTs from agent-service include the
// hybrid-loop's accumulated tool-result state — a single Gmail thread
// with multiple message bodies + headers already runs ~136 KB and
// other connectors (Drive doc content, large search payloads) routinely
// exceed it. The default `express.json()` body cap of 100 KB rejects
// these with "request entity too large" → coord returns 500 → agent
// marks the invocation FAILED. Bump to 10 MB; this endpoint is on the
// internal VPC and gated by `requireServiceAuth`, so the larger limit
// does not expand the public attack surface.
// Connect-RPC / gRPC requests carry their own message framing and must reach
// connect-express as a RAW STREAM. body-parser's json() runs `req.body = {}`
// for EVERY request *before* its content-type check (body-parser json.js:108),
// so for a binary Connect request (application/proto) it leaves req.body = {};
// connect-express's getPreparsedBody() then feeds that {} to the handler in
// place of the encoded bytes, and the handler throws "received parsed JSON
// request body, but content-type indicates binary format" (Code.Internal).
// Skip the JSON parser for Connect/gRPC framing so the raw stream survives;
// plain REST (application/json) is untouched and still gets parsed.
const jsonBodyParser = express.json({ limit: '10mb' });
app.use((req: Request, res: Response, next: NextFunction) => {
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (
    contentType.startsWith('application/proto') ||
    contentType.startsWith('application/grpc') ||
    contentType.startsWith('application/connect+')
  ) {
    return next();
  }
  return jsonBodyParser(req, res, next);
});

// Per Section 18: Trace context extraction and propagation middleware
// Must be early in the middleware chain to capture all operations
app.use(traceContextMiddleware);

// Populate req.ctx from trace context and x-tenant-id header
// Routers read req.ctx.tenantId for tenant isolation
app.use((req: Request, _res: Response, next: NextFunction) => {
  const tenantId = req.traceContext?.tenantId || (req.headers['x-tenant-id'] as string);
  if (tenantId && tenantId !== 'unknown') {
    req.ctx = {
      ...req.ctx,
      tenantId,
      traceId: req.traceContext?.traceId,
      agentId: req.traceContext?.agentId,
    };
  }
  next();
});

// Per Section 18: Structured logging middleware (now enhanced with trace context from middleware)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      tenant_id: req.traceContext?.tenantId || (req.headers['x-tenant-id'] as string),
      trace_id: req.traceContext?.traceId || (req.headers['x-trace-id'] as string),
      agent_id: req.traceContext?.agentId,
      workflow_id: req.traceContext?.workflowId,
    });
  });
  next();
});

// Per Section 12: tenant suspension is enforced via a three-layer model:
//   L1 (primary):   Cloud Scheduler job is paused on tenant.suspended event
//                   (see agent-lifecycle pause flow). Cron never fires.
//   L2 (this):      Edge kill-switch middleware blocks tenant-scoped requests.
//                   SKIPPED for scheduler endpoints because returning 4xx to
//                   Cloud Scheduler triggers retry storms, and the middleware
//                   can't make a smarter decision than the handler check (L3).
//   L3 (handler):   scheduled-invoke and scheduled-enqueue handlers read
//                   cached_entitlements.agent_execution_allowed and refuse
//                   execution if false. Returns 200 OK with skipped:true so
//                   Cloud Scheduler does NOT retry.
//
// WS-10.2 — canary read-back endpoint. Mounted before the kill-switch so the
// assertion runner can always reach it; the router self-guards to
// ENVIRONMENT === 'canary' and returns 404 in dev/prod.
app.use('/canary', canaryRouter);

// The skip list is for endpoints where L2 is the wrong enforcement layer:
//   - Cloud Scheduler entry points (defense in depth via L1 + L3)
//   - Health/metrics (must always respond)
//   - Cross-service read-only endpoints (called by Platform Backend, not user traffic)
app.use(createKillSwitchMiddleware({
  skipPaths: [
    '/health',
    '/healthz',
    '/canary',
    '/metrics',
    '/api/execution/scheduled-invoke',
    '/api/execution/scheduled-enqueue',
    // Cloud Tasks worker endpoints — receive deliveries from Cloud Tasks for
    // scheduled agent execution. Same rationale as the scheduler entry points:
    // returning 503 to Cloud Tasks would burn the queue's retry budget on
    // tenant-suspension state that the L3 handler check can decide more
    // accurately. The /agent-scheduled handler already does the entitlement
    // check (cached_entitlements.agent_execution_allowed) and the lifecycle
    // check inside the per-agent advisory lock.
    '/api/tasks/agent-scheduled',
    '/api/tasks/execute',
    '/api/tasks/deferred-execution',
    // Memory-system maintenance jobs (Cloud Tasks-triggered). Operator-plane
    // background work — tenant suspension does not gate cleanup, summarization,
    // or metrics flushing.
    '/api/tasks/memory-summarization-daily',
    '/api/tasks/memory-summarization-weekly',
    '/api/tasks/embedding-cache-cleanup',
    '/api/tasks/memory-metrics-flush',
    // Agent id-space mapping reads (`/internal/agents/{sync-state,list-mappings,
    // resolve}`). Every route on that router is a GET behind oidcGuard() +
    // requireServiceAuth, reads only `internal_agent_runtime_mapping`, and
    // executes nothing.
    //
    // It has to be exempt rather than merely harmless to exempt: the callers are
    // the cost-attribution ingesters, which MUST work for a tenant whose
    // execution is disabled. Disable a paying tenant mid-month and days 1-20 of
    // usage still needs attributing — their own tenant selection filters on
    // `tenants.status` and deliberately NOT on `agent_execution_allowed` for
    // exactly that reason. Gating this read on execution state breaks the one
    // consumer that has to be independent of it, and does so silently, because
    // the caller treats a failed fetch as "no mapping" and falls back to
    // pass-through — writing runtime ids into a column that must hold
    // internal_agents.id (INV-PB-009 / ADR-039).
    '/internal/agents/',
    // Cross-service RECONCILER reads. Same category as '/internal/agents/'
    // above, and missed for the same reason it was nearly missed: these are
    // mounted "unconditionally" with respect to the SERVICE_TYPE split, and
    // that reads like "always available" while the kill switch still gates
    // them.
    //
    // It is not harmless. For a tenant with agent_execution_allowed false,
    // /event-status answers 503 every cycle — and the
    // caller maps ANY non-2xx to status 'unknown', which does not mean "we
    // could not ask". It means "the subscriber never saw this event", and it
    // makes the reconciler REPUBLISH. Every event of that tenant is
    // republished every few minutes and then counted as stuck.
    //
    // Both endpoints are GETs behind requireServiceAuth that read one row and
    // execute nothing. Suspending a tenant must not blind the platform's own
    // reconciliation of that tenant — the same argument the /internal/agents/
    // comment makes at length for cost attribution.
    '/api/internal/event-status',
    '/api/internal/governance/wal-keys',
    // Deliberately NOT exempt: /api/internal/model-configs/resync/:id, which is
    // a POST that mutates. Its sibling GET (.../resolution) is a read and could
    // be, but an operator hitting resync on a suspended tenant is a decision
    // that should stay visible rather than being waved through by a prefix
    // match. Add it if break-glass on a disabled tenant is ever needed.
    // Cross-service read-only endpoints called by Platform Backend (insights, teams, HITL)
    '/api/invocations/stats',
    '/api/invocations/agent-costs',
    '/api/invocations/external-agent-tasks',
    '/api/invocations/hitl-decision-counts',
    // Phase 1B: agent status endpoint (`/api/invocations/<id>/status`) for
    // operator break-glass + admin UI must work even on suspended tenants.
    // Per the implementation plan: kill-switch matcher is `startsWith`-based, so
    // the cleanest skip is the `/api/invocations/` prefix; downstream handlers
    // still tenant-scope each query.
    '/api/invocations/',
    '/api/hitl-enforcement',
    '/api/usage-ledger',
    '/api/action-ledger',
    // Interactive chat tool proxy — called by Platform Backend on behalf of
    // authenticated users in chat sessions. Tenant suspension is enforced at
    // the admission layer (L3) within each endpoint handler.
    '/api/interactive-chat',
    // Skills read endpoint — called cross-service by platform-backend
    '/api/agents',
    // Background jobs — called by Cloud Scheduler, not user traffic.
    // Tenant suspension has no bearing on operator-plane reconciliation jobs.
    '/api/jobs',
  ],
}));

// -----------------------------------------------------------------------------
// Route registration (Phase 4 SERVICE_TYPE gated)
// -----------------------------------------------------------------------------
// Route ownership per plan §4a/§4b. Each service mounts only the routers it
// owns; monolith mounts everything for backward compatibility during rollout.

if (ownsAgentRoutes) {
  app.use(expressConnectMiddleware({ routes: registerTenantRuntimeService }));
  // PR2: BrowserSessionsService — dashboard surface for Anchor browser sessions.
  app.use(expressConnectMiddleware({
    routes: registerBrowserSessionsService,
    interceptors: [browserSessionsErrorInterceptor],
  }));

  // Tenant admin + agent lifecycle + instruction compiler + execution surface.
  // Skills router must come before agentLifecycleRouter — the lifecycle router
  // has GET /:agentId which would otherwise catch /missing-skills as a UUID
  // param before the skills router can handle it.
  app.use('/api/agents', skillsRouter);
  app.use('/api/audit-logs', auditRouter);
  // Control-plane access to the tenant's memory layer: skill-feedback recording
  // a refined skill, and the MCP share/read context tools, both reach the store
  // through here. Unmounted until now, so both took a 404 and swallowed it.
  app.use('/api/memory', memoryRouter);
  app.use('/api/tenant', tenantApiRouter);
  // Reconciler-facing /internal/agents/{sync-state,list-mappings} (plan §6.1, §6.3).
  // Mount before agentLifecycleRouter so :id doesn't shadow the literal routes.
  app.use('/internal/agents', syncStateRouter);
  app.use('/api/agents', agentLifecycleRouter);
  // No /api/instruction-compiler. The compile/review/activate lifecycle it
  // served belonged to the pre-F-5 architecture ("Per Section 9"), alongside
  // the coordinator-driven workflow graph and the leased workflow_tasks queue
  // that replaced. It never created a row: production compiled_instructions
  // holds 1,351 rows and every one has source='internal_agent' written
  // straight to status='active' by internal-agent-instruction-service, with
  // ZERO in draft / pending_approval / approved / rejected / archived.
  //
  // Its capabilities exist elsewhere and are used: the control plane reviews a
  // distilled agent before creation (consent-follows-scope), reflection
  // reviews LEARNED changes through its suggestion queue with baseline and
  // revert (ADR-008), validation happens at write time, and every reader of
  // compiled_instructions goes direct to the database rather than over HTTP.
  app.use('/api/execution', agentExecutionRouter);
  app.use('/api/execution', scheduledInvokeHandler);
  app.use('/api/tasks', cloudTasksHandler);
  // Self-wake operator surface (service-auth); PB's tenant-admin endpoint proxies here.
  app.use('/api/internal/wakes', wakeOperatorInternalRouter);
  // Plan v6.1 Phase 0.4: PB-facing standalone dispatch (enqueue-standalone service-auth,
  // execute-standalone Cloud Tasks OIDC). Separate router — mixed auth models.
  app.use('/api/tasks', standaloneTasksHandler);
  // ADR-030: "Run again" — POST /api/internal/agents/:agentId/invocations/:invocationId/rerun
  app.use('/api/internal/agents', rerunRouter);

  // Internal Cron endpoints (computed-metric poller, window prune,
  // entity-state prune). Invoked by Cloud Scheduler jobs declared in
  // r5_scheduler_jobs.tf.

  const internalCronHandler = require('./handlers/internal-cron-handler').default;
  app.use('/api/internal', internalCronHandler);

  // B6 — per-agent benchmark compute (backend only; service-auth). GET /api/internal/agent-benchmarks.
  const { agentBenchmarksRouter } = require('./insights/agent-benchmarks');
  app.use('/api/internal', agentBenchmarksRouter);

  // WS-9.2 — Gmail Pub/Sub history-push receiver. Endpoint:
  // POST /api/internal/gmail-history-push (mounted via the same path the
  // gmail-history-${env}-push subscription points at; see terraform).
  const gmailHistoryPushHandler = require('./handlers/gmail-history-push-handler').default;
  app.use('/api/internal', gmailHistoryPushHandler);

  // Invocations and threads routes
  app.use('/api/invocations', invocationsRouter);
  app.use('/api/threads', threadsRouter);
  app.use('/api/threads', streamingRouter);

  // Co-located with streamingRouter: the events router broadcasts to the
  // in-process SSE clients registered above.

  const { sandboxEventsRouter } = require('./internal-api/sandbox-events-router');
  app.use('/internal/sandbox', sandboxEventsRouter);

  // HITL enforcement routes (called cross-service by Platform Backend on behalf
  // of authenticated /review users; tenantId comes from req.ctx, decidedBy
  // comes from request body — see hitl-enforcement/router.ts)
  app.use('/api/hitl-enforcement', hitlRouter);

  // Review queue for learned response shapes. Same access model as HITL: the
  // control plane calls on behalf of an authenticated reviewer, and tenantId
  // comes from req.ctx so nobody can decide another workspace's proposals.
  const { learnedShapesRouter } = require('./tool-gateway/learned-shapes-router');
  app.use('/api/learned-shapes', learnedShapesRouter);

  // Action/usage ledger read endpoints (used by dashboard via platform-backend).
  // Writes now go through the governance-engine RPC; these routers still expose
  // read paths and legacy local-table queries during cutover.
  app.use('/api/action-ledger', actionLedgerRouter);
  app.use('/api/usage-ledger', usageLedgerRouter);
  app.use('/api/internal/web-tools', webToolsDiagnosticRouter);

  // Interactive chat surface — tool-proxy + SDK turn handler share the same
  // /api/interactive-chat namespace. Workspace-delete is mounted inside
  // start() once DB_PASSWORD is hydrated (see §R5 Fix 9 notes below).
  app.use('/api/interactive-chat', interactiveChatRouter);
  app.use('/api/interactive-chat', chatTurnRouter);
  // Automated agent test harness — service-auth gated, runs a chat
  // turn with an ephemeral synthetic invocation and returns the event
  // trace as JSON so CI / smoke jobs can assert on what tools fired.
  app.use('/api/internal/test-harness', testHarnessRouter);
  app.use('/api/agents/:agentId/loop', loopRouter);
}

// REST routers (mounted at /api/v1). Each router defines its full resource
// path internally (`/workflows`, `/tool-calls`, `/evaluations`, etc.) so new
// routers can be added without changing mount wiring. Older routers under
// /api/* are in-flight for the same treatment.
if (ownsCoordinatorRoutes) {
  app.use('/api/v1', coordinatorRouter);
}

if (ownsToolGatewayRoutes) {
  app.use('/api/v1', toolGatewayRouter);
  // Thin HTTP proxy that forwards /api/connectors/* to connector-service.
  app.use('/api/connectors', connectorsRouter);

  // Co-located with toolGatewayRouter: the MCP router calls
  // toolGatewayService.executeConnectorCall and reads tool-catalog tables.

  const { sandboxMcpRouter } = require('./internal-api/sandbox-mcp-router');
  app.use('/internal/sandbox', sandboxMcpRouter);
}

// Tool catalog — read-only per-tenant aliased tool names for distill. Mounted
// on both agent-service and tool-gateway-service because platform-backend's
// distill flow (cross-project caller) reaches the tenant runtime via
// agent-service's public ingress; tool-gateway-service is internal-only and
// would reject the cross-project call at the network layer.
if (ownsAgentRoutes || ownsToolGatewayRoutes) {
  app.use('/api/v1/tool-catalog', toolCatalogRouter);
}

if (ownsReflectionRoutes) {
  app.use('/api/v1', evaluationsRouter);
}

if (ownsSandboxExecutor) {
  (async () => {
    try {
      const { CloudRunSandboxProvider } = await import('./execution-environments/cloud-run-sandbox-provider');
      const { SandboxExecutor } = await import('./execution-environments/sandbox-executor');
      const { SandboxStateRepository } = await import('./execution-environments/sandbox-state-repository');
      const { SandboxUsageRepository } = await import('./execution-environments/usage-repository');
      const { SandboxAuditRepository } = await import('./execution-environments/audit-repository');
      const { SandboxOutputSanitizer } = await import('@liftoffos/sandbox-validators');
      const { SandboxRateLimiter } = await import('./execution-environments/rate-limiter');
      const { createSandboxExecutorRouter } = await import('./execution-environments/sandbox-executor-router');
      const { getDefaultSandboxCreditCost } = await import('./execution-environments/credit-calculator');
      const { usageLedgerService } = await import('./usage-ledger/service');

      // Returns rates in MICRO-CREDITS (1 μcr = $0.000001). The credit-
      // calculator's calculate* helpers all operate in μcr internally; the
      // legacy `credits` field on persistence rows is derived via
      // microCreditsToCredits() at write time.
      const creditCostProvider = {
        getCreditCost: async (_tenantId: string, lookup: { actionType: string; connector: string }) => getDefaultSandboxCreditCost(lookup.actionType),
      };

      // Derive the runtime SA email from the tenant id when
      // RUNTIME_SERVICE_ACCOUNT_EMAIL isn't set explicitly. Tenant SA naming
      // convention (per Terraform infra repo, module.iam):
      //   tenant-{TENANT_ID}-runtime@tenant-{TENANT_ID}-{ENVIRONMENT}.iam.gserviceaccount.com
      const tenantIdEnv = process.env.TENANT_ID ?? '';
      const envName = process.env.ENVIRONMENT ?? '';
      const derivedRuntimeSa = tenantIdEnv && envName
        ? `tenant-${tenantIdEnv}-runtime@tenant-${tenantIdEnv}-${envName}.iam.gserviceaccount.com`
        : '';
      const runtimeSaEmail = process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL ?? derivedRuntimeSa;

      // Per-sandbox sidecars bake RUNTIME_BASE_URL into Cloud Run env at
      // create time. The orchestrator owns the sidecar-callback proxy at
      // /internal/sandbox/*, so prefer its own URL. Fall back to the
      // agent-service URL when running monolith (no separate orchestrator
      // service) — monolith mounts both the proxy and the backend routers.
      const sidecarRuntimeBaseUrl = process.env.SANDBOX_EXECUTOR_URL
        ?? process.env.TENANT_RUNTIME_INTERNAL_URL;

      const provider = new CloudRunSandboxProvider({
        projectId: process.env.GCP_PROJECT_ID ?? '',
        region: process.env.GCP_REGION ?? 'us-west1',
        imageRegistry: process.env.SANDBOX_IMAGE_REGISTRY ?? '',
        kmsKeyName: process.env.SANDBOX_KMS_KEY_NAME ?? '',
        defaultImageTag: process.env.AIO_SANDBOX_IMAGE_TAG ?? '2.0.0',
        runtimeBaseUrl: sidecarRuntimeBaseUrl,
        runtimeServiceAccountEmail: runtimeSaEmail,
        // Dedicated minimal SA only. NEVER fall back to the privileged runtime SA — that fallback ran
        // agent code as the tenant's god-identity (proven). Fail-closed enforced in provider.create().
        sandboxServiceAccountEmail: process.env.SANDBOX_SERVICE_ACCOUNT_EMAIL,
      });

      const stateRepo = new SandboxStateRepository();
      const usageRepo = new SandboxUsageRepository();
      const auditRepo = new SandboxAuditRepository();

      const executor = new SandboxExecutor(
        provider as unknown as ConstructorParameters<typeof SandboxExecutor>[0],
        stateRepo,
        usageRepo,
        auditRepo,
        new SandboxOutputSanitizer(),
        new SandboxRateLimiter(),
        creditCostProvider,
        usageLedgerService,
      );

      // git_clone had no credentials, so every clone of a PRIVATE repository
      // failed — which is all of them. Resolved here rather than inside the
      // executor so it keeps no connector-service knowledge, and the token
      // reaches git through the environment only (see buildGitCredentialEnv).
      // Scoped to what THIS agent is bound to, not to what the tenant owns: the
      // agent's own integrations decide which connector it may borrow a token
      // from, so a repo host it has no binding for resolves to undefined and the
      // clone is attempted unauthenticated rather than with somebody else's
      // credential. Same source and same normalizer the event filters use, so a
      // row written through PB's older `integrationId` path still resolves.
      executor.setGitCredentialResolver(async ({ tenantId, agentId, host }) => {
        const wantedType = host.includes('gitlab') ? 'gitlab' : 'github';
        const { getPool } = await import('./infrastructure/database');
        const { normalizeIntegrationsField } = await import('./instruction-compiler/integration-shape');

        const res = await getPool().query(
          `SELECT cia.integrations
             FROM cached_internal_agents cia
             JOIN internal_agent_runtime_mapping m
               ON m.internal_agent_id = cia.internal_agent_id
              AND m.tenant_id = cia.tenant_id
            WHERE m.agent_id = $1 AND m.tenant_id = $2
            LIMIT 1`,
          [agentId, tenantId],
        );
        if (res.rowCount === 0) return undefined;

        const binding = normalizeIntegrationsField(res.rows[0].integrations)
          .find((i) => i.type === wantedType);
        if (!binding?.id) return undefined;

        const { getConnectorServiceClient } = await import('./connectors/connector-service-client');
        const creds = await getConnectorServiceClient().getCredentials({
          tenantContext: { tenantId },
          connectorId: binding.id,
        });
        return creds.oauth?.accessToken || undefined;
      });

      // Monolith only: in this process the tool-gateway singleton is the
      // catalog dispatcher, so wire the in-process executor straight into
      // it. On the dedicated sandbox-executor service the tool-gateway
      // singleton in this process is never used — tool-gateway-service
      // lives in another process and wires a SandboxExecutorClient further
      // down.
      if (ownsToolGatewayRoutes) {
        const { toolGatewayService } = await import('./tool-gateway/router');
        toolGatewayService.setSandboxExecutor(executor);
      }

      stateRepo.hydrateAllJwtSecrets(provider as unknown as { restoreJwtSecret: (id: string, ct: Buffer) => Promise<void> }).catch(() => undefined);

      // Allow-list of SAs whose OIDC tokens may invoke the orchestrator's
      // OIDC-gated routes. Each entry derived from tenant id + env so that
      // the list is correct regardless of which service-type process is
      // executing this bootstrap (RUNTIME_SERVICE_ACCOUNT_EMAIL is overloaded
      // — on sandbox-executor it points at sandbox-executor's own SA).
      const sandboxExecutorUrl = process.env.SANDBOX_EXECUTOR_URL ?? '';
      const tenantRuntimeSa = tenantIdEnv && envName
        ? `tenant-${tenantIdEnv}-runtime@tenant-${tenantIdEnv}-${envName}.iam.gserviceaccount.com`
        : '';
      const sandboxExecutorSa = tenantIdEnv && envName
        ? `sandbox-executor@tenant-${tenantIdEnv}-${envName}.iam.gserviceaccount.com`
        : '';
      const schedulerSa = process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT
        ?? (tenantIdEnv && envName ? `tenant-${tenantIdEnv}-scheduler@tenant-${tenantIdEnv}-${envName}.iam.gserviceaccount.com` : '');
      const allowedCallerSas = (): string[] => [tenantRuntimeSa, sandboxExecutorSa, schedulerSa].filter(Boolean);

      app.use(createSandboxExecutorRouter({
        executor,
        sandboxExecutorUrl,
        allowedCallerSas,
        agentServiceUrl: process.env.AGENT_SERVICE_URL ?? '',
        toolGatewayServiceUrl: process.env.TOOL_GATEWAY_SERVICE_URL ?? '',
      }));

      // InstanceAliveTicker bills the per-second wall-clock time the Cloud
      // Run instance is alive — fires every 30 s (SANDBOX_ALIVE_TICK_MS),
      // walks sandbox_state, and CAS-advances last_billed_at per sandbox so
      // two replicas can't double-bill the same window. The executor's
      // cleanup path flushes the final partial window before teardown via
      // aliveTicker.tick().
      const { InstanceAliveTicker } = await import('./execution-environments/instance-alive-ticker');
      const aliveTicker = new InstanceAliveTicker(usageRepo, creditCostProvider, usageLedgerService);
      executor.setAliveTicker(aliveTicker);
      aliveTicker.start();

      logger.info({ msg: 'Sandbox subsystem wired' });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Failed to wire sandbox subsystem');
    }
  })();
}

// Tool-gateway split mode: the orchestrator lives in another process. Inject
// an HTTP client into the tool-gateway singleton so sandbox tool calls hop
// to /v2/execute. Monolith bypasses this — the in-process executor injected
// above already serves the singleton in the same process.
//
// AGENT ROUTES TOO, not just tool-gateway routes. `code_session` asks the
// singleton for a sandbox (`sandboxExecutorForCodeSession`), and it runs in the
// AGENT service: the MCP catalog is assembled by agent-execution/service.ts,
// which is where the tool's handler executes. Wiring only the tool-gateway
// service left the singleton empty in the one process that needed it, so
// CODE_SESSION_EXECUTION=sandbox would quietly fall back to in-process and log
// `code_session_sandbox_requested_but_unavailable` — the flag on, the substrate
// unused, and nothing failing.
if ((ownsAgentRoutes || ownsToolGatewayRoutes) && !ownsSandboxExecutor) {
  (async () => {
    try {
      const { SandboxExecutorClient } = await import('./execution-environments/sandbox-executor-client');
      const { toolGatewayService } = await import('./tool-gateway/router');
      const sandboxExecutorUrl = process.env.SANDBOX_EXECUTOR_URL ?? '';
      if (!sandboxExecutorUrl || sandboxExecutorUrl.startsWith('placeholder://')) {
        logger.warn({ SANDBOX_EXECUTOR_URL: sandboxExecutorUrl }, 'SANDBOX_EXECUTOR_URL not configured; sandbox tool calls will fail until patch-split-service-urls runs');
        return;
      }
      const client = new SandboxExecutorClient(sandboxExecutorUrl);
      toolGatewayService.setSandboxExecutor(client);
      logger.info({ msg: 'Sandbox executor client wired', url: sandboxExecutorUrl });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Failed to wire sandbox executor client');
    }
  })();
}

// R5 TE-R5-001: TEST_MODE-gated simulate-sigterm endpoint for e2e drain tests.
// Production never has TEST_MODE=enabled. Returns 404 when disabled.
if (process.env.TEST_MODE === 'enabled') {
  app.post('/internal/simulate-sigterm', (_req: Request, res: Response) => {
    res.json({ ok: true, simulating: 'SIGTERM' });
    setImmediate(() => process.emit('SIGTERM'));
  });
}

// Connector content — internal hybrid retrieval index.
// Called by tool-gateway (via SDK) and platform-backend for cross-tenant search.
app.use('/api/internal/connector-content', connectorContentRouter);
// Operator-only. Never registered as an agent tool: a model that can see its
// own rollback stops treating destructive actions as expensive.
app.use('/api/internal/undo', undoRouter);
app.use('/api/internal/data-landscape', dataLandscapeRouter);

app.use('/api/internal/provenance', provenanceRouter);

// Event-status — read-only ledger lookup polled by platform-backend's
// outbox-acknowledgment-reconciler (Fix B-2). Mounted unconditionally because
// the reconciler can call any tenant's runtime regardless of SERVICE_TYPE split.
app.use('/api/internal', eventStatusRouter);

// governance_wal idempotency keys — read by governance-engine's reconciliation
// job. Mounted unconditionally for the same reason event-status is: the caller
// is a central reconciler and cannot know which service of the SERVICE_TYPE
// split is publicly ingressible. It reads the database directly rather than
// crossing the VPC boundary, which it cannot do — see wal-keys-router.ts.
app.use('/api/internal', walKeysRouter);

// Operator-callable model-config cache resync (closes PB→TR drift if a
// tenant.model_config.updated event is ever lost).
app.use('/api/internal', modelConfigResyncRouter);

// Operator-callable embedding provider switch — ALTERs every embedding
// column to halfvec(newNativeDim), NULLs existing embeddings, kicks the
// embedding-backfill Cloud Run Job. Entitlement update is operator-side
// on platform-backend BEFORE this is called.
app.use('/api/internal', providerSwitchRouter);

// Per Section 16: Metrics endpoint for Cloud Scheduler to trigger metric emission
app.use('/api/metrics', metricsRouter);

// Background jobs — called by Cloud Scheduler via HTTP POST.
// No tenant-scoped kill-switch enforcement needed (operator plane, not user traffic).
app.use('/api/jobs', jobsRouter);

// Health check. `/healthz` is an alias used by the Pub/Sub push-endpoint
// healthcheck Job and the runtime_url validator (Fix G / Fix H). Both routes
// return the same shape so probes don't need to discover which path is wired.
app.get(['/health', '/healthz'], (_, res) => res.json({ status: 'healthy' }));

// WS-9.6 — Express-route introspection for the CI scheduler-target
// validator. Lists every (method, path) registered on the app. Service-auth
// gated (TENANT_RUNTIME_SERVICE_TOKEN, the same shared secret every other
// internal route uses); no public exposure of route inventory.
//
// Walks the router stack recursively: Express creates two layer shapes we
// care about — leaf routes (layer.route set) and sub-routers mounted via
// app.use(path, router) (layer.name === 'router', layer.handle.stack
// populated, layer.regexp encodes the mount path). The earlier flat filter
// only saw leaf routes registered directly on the app, which hid every
// router mounted under /api/* and made the CI validator a no-op.

function expressMountPath(regexp: any): string {
  if (regexp?.fast_slash) return '';
  const src: string = regexp?.source ?? '';
  let p = src.startsWith('^') ? src.slice(1) : src;
  p = p.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  p = p.replace(/\\\/\?\$$/, '');
  return p.replace(/\\\//g, '/');
}

function collectRoutes(stack: any[], prefix = ''): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (layer?.route) {
      const path = prefix + layer.route.path;
      for (const m of Object.keys(layer.route.methods)) {
        if (layer.route.methods[m]) out.push({ method: m.toUpperCase(), path });
      }
    } else if (layer?.name === 'router' && layer.handle?.stack) {
      out.push(...collectRoutes(layer.handle.stack, prefix + expressMountPath(layer.regexp)));
    }
  }
  return out;
}
app.get('/__routes', (req, res) => {
  if (req.headers['x-service-auth'] !== getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const stack = (app as any)._router?.stack ?? [];
  res.json({ routes: collectRoutes(stack) });
});

// Per Section 18: Global error handler with structured logging
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    tenant_id: req.headers['x-tenant-id'] as string,
    trace_id: req.headers['x-trace-id'] as string,
  });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;

async function start() {
  logger.info({ SERVICE_TYPE }, 'Starting tenant runtime');

  // ---- Process-wide bootstrap (runs in every SERVICE_TYPE) ------------------

  // D20: validate MEM_* / HARVEST_* env vars at boot. Fail fast on typos that
  // would otherwise produce silent NaN scoring at runtime.
  const { validateMemoryEnv } = await import('./memory/env-validator');
  validateMemoryEnv();

  // Fail the revision BEFORE traffic if a configured engine cannot
  // initialize: a self-managing engine whose SDK is not resolvable — the
  // defaults for OpenAI (Codex), xAI and the open-weights families (opencode),
  // or the flag-selected GOOGLE_ENGINE=adk — or an unrecognized engine id.
  const { assertEnabledEnginesInitializable } = await import('./agent-execution/certification/startup-validation');
  assertEnabledEnginesInitializable();

  // Hydrate secrets into process.env BEFORE anything else. The rest of the
  // codebase reads process.env.X synchronously throughout (DB password, the
  // service token, OAuth client credentials, OpenAI key) — none of those
  // values are bound to Cloud Run as env vars anymore. See
  // infrastructure/secrets.ts SECRET_MANIFEST and the comment block on
  // loadSecretsToEnv() for the full rationale.
  await loadSecretsToEnv();

  // Model-registry loader — poll platform-backend's /api/internal/model-registry for
  // the synced open-weights rates AND tier-derived branding, so TR cost attribution
  // AND customer-facing model redaction match PB from one source, no duplicated static
  // tables. Best-effort + 15-min TTL; both fall back to their static tables until
  // loaded. Guarded on the PB-callback env so roles without it stay quiet.
  if (process.env.PLATFORM_BACKEND_URL && getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN')) {
    const { startModelRegistryRefresh } = await import('./llm/model-registry-loader');
    startModelRegistryRefresh();
  }

  // Verify the schema-cascade invariant: every embedding column is
  // halfvec(ACTIVE_DIM). Migration 259 establishes this; the verifier
  // catches drift between code and schema (the migration-258 lesson:
  // silent-NULL inserts because of dim mismatch are not acceptable).
  // Must run AFTER loadSecretsToEnv() so DB_PASSWORD is set on env.
  // Bypass with MEM_SKIP_DIM_BIND=1 only in test/dev when explicitly
  // running against a not-yet-migrated DB.
  if (process.env.MEM_SKIP_DIM_BIND !== '1') {
    const { verifyEmbeddingDimCascade } = await import('./memory/dim-bind-verifier');
    await verifyEmbeddingDimCascade();
  }

  // R5 Fix 9: mount the workspace-delete router (/api/interactive-chat/...)
  // now that DB_PASSWORD is populated in process.env. `buildWorkspaceDeleteRouter`
  // calls `getPoolForService` which builds a connection string from env vars;
  // creating the pool before hydration baked an empty password into the pool.
  // Gated to agent-service (and monolith) because the route lives under
  // /api/interactive-chat which agent owns.
  if (ownsAgentRoutes) {
    app.use(buildWorkspaceDeleteRouter(getPoolForService('scheduled-execution')));
  }

  // R5 Fix 8: install process-level secret scrubbers on stdout/stderr and
  // uncaughtException / unhandledRejection. Must run BEFORE any other code
  // that may log errors containing credentials.
  installProcessScrubbers();

  // R5 Fix 8: load the UntrustedContentFramer server secret from Secret Manager
  // (falls back to env var for dev). The framer is a HARD dependency for
  // untrusted-content wrapping; if it fails to load, chat turns run in a
  // degraded mode where untrusted wrapping is disabled (per-turn warning).
  try {
    const envSecret = process.env.FRAMER_SECRET;
    if (envSecret && envSecret.length >= 32) {
      await loadFramerSecret(async () => Buffer.from(envSecret, 'base64'));
    } else {
      const sm = new SecretManagerServiceClient();
      const secretName = process.env.FRAMER_SECRET_NAME
        ?? `projects/${process.env.GCP_PROJECT}/secrets/framer-secret/versions/latest`;
      await loadFramerSecret(async () => {
        const [version] = await sm.accessSecretVersion({ name: secretName });
        const payload = version.payload?.data;
        if (!payload) throw new Error('framer-secret payload empty');
        return Buffer.from(payload as Uint8Array);
      });
    }
    scrubLogger.info({ event: 'startup_complete' });
  } catch (err) {
    // Do not fail startup — the framer is best-effort; untrusted wrapping is
    // disabled if secret unavailable, logged per-turn.
    logger.warn({ err: (err as Error).message }, 'framer secret load failed — untrusted wrap disabled');
  }

  // R5 Fix 8: wire tenant-patterns pool into the secret scrubber so
  // tenant-extensible patterns can be resolved.
  setTenantPatternsPool(getPoolForService('scheduled-execution'));

  // R5 BE-R5-006: non-blocking schema-version poll. Readiness probe returns
  // 503 until schema_version = 5 is present. Supports rolling deploys.
  pollSchemaUntilReady(getPoolForService('scheduled-execution')).catch((err) => {
    scrubLogger.error({ event: 'schema_check_timeout', attempts: 0, err: (err as Error).message });
  });

  // R5 Fix 4: install SIGTERM drain handler that aborts in-flight turns and
  // force-cleans chat_turn_locks on shutdown.
  drainController.install(getPoolForService('scheduled-execution'));

  // One memory line a minute, whatever is happening. A container killed for
  // memory leaves an OOM in the infrastructure log and nothing in ours: the run
  // in flight simply stops, and the stalled-run reconciler files it as a stall
  // with no cause. This is the record that survives the kill, because it was
  // written before it.
  startMemoryMonitor();

  // ---- Tool-schema cache (agent + tool-gateway; both query tool metadata) ---

  // Phase 2c: seed the tool-schema cache from the connector-service before
  // any agent can spin up. On failure, initToolSchemaCache() logs a warn
  // and leaves the cache empty; the 5-minute background refresh self-heals.
  // Must run BEFORE validateRegistryAtStartupOrThrow() because that
  // validator walks the cache.
  //
  // Tool-gateway obviously needs it (dispatch lookups). Agent-service needs
  // it to expose the tool list to the Claude SDK at invocation start. Other
  // services skip it — keeps their cold-start light.
  if (ownsAgentRoutes || ownsToolGatewayRoutes) {
    await initToolSchemaCache();

    // Validate every tool schema currently in the cache against ajv before
    // we serve any traffic. Last-line defense against a malformed tool schema
    // reaching an LLM provider — see registry-validator.ts for the full
    // rationale. On failure, throws a structured error which falls through
    // to start().catch() below, exits the process with non-zero, and Cloud
    // Run keeps the previous good revision serving traffic.
    //
    // Phase 2c: the old MCP registry conformance check was removed; the MCP
    // URL registry is gone (connector-service owns MCP routing). Equivalent
    // conformance lives inside the connector-service's own startup check.
    validateRegistryAtStartupOrThrow();

    // The observed-shape store's read side. Started here because this is the
    // one block that both runs the gateway door — the only place shapes are
    // observed — and has the tool catalog loaded, which the report joins
    // against to say what is MISSING rather than what was seen.
    //
    // Silent until it has something to propose, so a fully declared estate
    // logs nothing.
    startShapeProposalReport();
  }

  // ---- Telemetry + LLM tracking + DB pools (every SERVICE_TYPE) -------------

  // Per Section 18: Initialize OpenTelemetry telemetry before other services
  // This must happen early to ensure all operations are traced
  await initTelemetry();

  // Track every LLM call — must be registered before any LLM usage
  initLLMUsageTracking();

  // Pre-warm DB connection pools before accepting traffic.
  // Eliminates cold-start connection timeouts on first event delivery.
  await warmPools();

  // Periodic pool-stats logger. Emits totalCount / idleCount / waitingCount
  // per service pool every 30s so a connection leak shows up as a monotonic
  // `total - idle` climb on a single pool. Cheap (in-process counters,
  // structured JSON) and the only path to identifying which call site is
  // checking out without releasing.
  setInterval(() => {
    const stats = getPoolStats();
    for (const [service, s] of Object.entries(stats)) {
      logger.info(
        { event: 'pool_stats', service, total: s.total, idle: s.idle, waiting: s.waiting, inUse: s.total - s.idle },
        'pool_stats',
      );
    }
  }, 30_000).unref();

  // ---- Agent-scoped background jobs ----------------------------------------

  if (ownsAgentRoutes) {
    // Start the transactional outbox worker. Delivers control_plane_outbox rows
    // to the platform-backend so SDK-engine audit logs appear on the /activity
    // page. Must start after loadSecretsToEnv() so CONTROL_PLANE_API_URL and
    // TENANT_RUNTIME_SERVICE_TOKEN are available in process.env.
    startOutboxWorker();

    // Keep the workspace data census current. No-op unless CENSUS_ENABLED=1 —
    // enumeration spends the same vendor quota agent work does, so starting it
    // is a deliberate decision rather than a default.
    startEnumerationScheduler();

    // Deep research durability layer. Outbox drainer (10s) recovers from
    // Pub/Sub publish failures; reconciler (60s adaptive) re-polls Perplexity
    // for unresolved submissions. Both .unref() — don't keep the process alive
    // during shutdown. Drain integration on SIGTERM is in the `shutdown`
    // function below (edit c) — NOT a separate SIGTERM handler, because the
    // existing handler at line 651 would race ours and may process.exit
    // before our drain completes.
    startOutboxDrainer();
    startReconciler();
    // Trust-ledger delivery: drain approval-resolution trust decisions to governance.
    startActionTrustOutboxDrainer();

    // Self-wake outbox drain (15s) + lease reconciler (60s). Gated on SELF_WAKE_ENABLED.
    (await import('./reactive-subscriptions/wake-delivery-drain')).startWakeDrainer();

    // The other half of the control plane's deletion purge: an agent archived
    // past the grace period, its learned context and its cached row. Started
    // here rather than left to a scheduler, because a deployment that never
    // created one would keep the memories of every deleted agent while the
    // product reported them gone.
    (await import('./maintenance/purge-archived-agents')).startArchivedAgentPurgeWorker();

    // R5 Fix 1: background chat-thread workspace reaper with backlog-aware cadence.
    scheduleChatReaper();

    // Phase 2: fire-and-forget cleanup of stale per-invocation workspaces
    // left behind by crashed or timed-out invocations from previous instances.
    reapStaleWorkspaces().catch(() => {});

    // Phase 3: governance-engine integration background jobs. Gated on the
    // feature flag: 'off' skips everything (in-process governance only);
    // 'shadow' and 'on' both start the WAL drainer + governance events
    // subscriber. The subscriber demultiplexes the shared governance-events
    // topic (kill-switch, correction_captured, late_feedback_flagged,
    // action_compensated) onto per-event handlers.
    //
    // Phase 4: runs in agent-service (preflight cache + WAL writes live in the
    // invocation lifecycle). Monolith inherits this via ownsAgentRoutes=true.
    if (getGovernanceServiceMode() !== 'off') {
      try {
        await startGovernanceEventsSubscriber();
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'governance events subscriber failed to start (non-fatal)',
        );
      }
      startWalDrainer();
    }

    // Start event trigger subscriber for push-style agent execution
    // Non-fatal: if Pub/Sub topic/subscription doesn't exist yet, log and continue
    try {
      await startEventTriggerSubscriber();
    } catch (error) {
      logger.warn('Event trigger subscriber failed to start (non-fatal)', {
        error: (error as Error).message,
      });
    }

    // Part 3: tenant_runtime_config cache invalidation subscriber.
    // Pulls from `tenant-runtime-config-updated-sub-${tenant_id}` (cross-
    // project) and drops the LRU entry for the matching tenant whenever an
    // operator UPSERT + manual publish happens. Non-fatal: if the
    // subscription isn't provisioned yet, log and continue.
    try {
      const { startTenantRuntimeConfigSubscriber } = await import('./events/tenant-runtime-config-subscriber');
      startTenantRuntimeConfigSubscriber();
    } catch (error) {
      logger.warn('tenant-runtime-config subscriber failed to start (non-fatal)', {
        error: (error as Error).message,
      });
    }

    // Start the reactive-subscriptions Pub/Sub router. Non-fatal: if the -rs
    // subscriptions aren't yet provisioned (early bring-up in a new env), log
    // and continue — the next deploy after Terraform apply picks it up.
    try {
      const { startSubscriptionRouter } = await import('./reactive-subscriptions/subscription-router');
      await startSubscriptionRouter();
    } catch (error) {
      logger.warn('Subscription router failed to start (non-fatal)', {
        error: (error as Error).message,
      });
    }

    // Consume correction.requested / correction.bulk_requested. The control
    // plane publishes these when someone asks for an action to be corrected;
    // without a consumer attached they are discarded by Pub/Sub and the
    // request is lost with no error anywhere. Non-fatal on the same terms as
    // the subscribers above.
    try {
      const { initCorrectionSubscriber } = await import('./corrections/subscriber');
      initCorrectionSubscriber();
    } catch (error) {
      logger.warn('Correction subscriber failed to start (non-fatal)', {
        error: (error as Error).message,
      });
    }
  }

  // ---- Coordinator-scoped background jobs ----------------------------------

  if (ownsCoordinatorRoutes) {
    // One-shot startup migration of all Cloud Scheduler agent jobs in this
    // tenant project. Patches any whose httpTarget.uri or body has drifted
    // from what the current code writes (e.g. legacy /scheduled-invoke URI,
    // legacy `triggeredBy: 'scheduler'` body literal). Idempotent and
    // non-blocking — failures are logged but never block startup, because
    // the resumeJob() self-healing path is the second line of defense.
    // Run after warmPools() so the migration logging stream is up.
    await migrateAllAgentSchedulerJobs();

    // Per Section 4 + Phase 5 (push migration): mount HTTP push handler for
    // control-plane Pub/Sub topics. Pub/Sub HTTPs each message to
    // POST /internal/pubsub/<topic>; the handler verifies the OIDC bearer
    // token, decodes the envelope, and calls dispatchEvent() in subscriber.ts.
    //
    // Future-tenant monolith mode (Gap 12): if SERVICE_TYPE=monolith ever ships
    // again, this same router mounts on it, but a monolith tenant would also
    // need its own pubsub_push.tf variant pointing the push endpoint at the
    // monolith URL (not coordinator-service). Out of scope for this phase.
    // WS-10 — the ephemeral canary runs fully in-process
    // (USE_CLOUD_TASKS_EXECUTION=false) with NO Pub/Sub push topology, so the
    // control-plane push handler is neither wired nor needed. Skipping it also
    // keeps COORDINATOR_SERVICE_URL unset, which is what forces in-process
    // coordinator dispatch (dispatcher.ts) rather than an HTTP hop.
    if (process.env.ENVIRONMENT === 'canary') {
      logger.info('Canary environment — skipping control-plane Pub/Sub push handler');
    } else {
      if (!process.env.COORDINATOR_SERVICE_URL) {
        logger.error('Push handler requires COORDINATOR_SERVICE_URL — refusing to start');
        process.exit(1);
      }
      if (!process.env.PUBSUB_PUSH_SA_EMAIL) {
        logger.error('Push handler requires PUBSUB_PUSH_SA_EMAIL — refusing to start');
        process.exit(1);
      }
      app.use('/internal/pubsub', buildPushHandlerRouter());
      logger.info(`Push handler mounted for ${SUBSCRIBED_EVENTS.length} topics`);
    }

    // Per Section 19: Check for reconcile mode on startup
    if (process.env.RECONCILE_MODE === 'true') {
      logger.info({ message: 'Starting in reconcile mode' });
      const { CoordinatorService } = await import('./coordinator/service');
      const coordinator = new CoordinatorService();
      await coordinator.runReconciliation();
      logger.info({ message: 'Reconciliation complete' });
    }

    // Per implementation plan Phase 5.3: Start research scheduler if enabled
    if (process.env.ENABLE_RESEARCH_SCHEDULER === 'true') {
      startResearchScheduler(logger);
    }
  }

  // WS-2.4: catalog/handler symmetry invariant. Refuses to start on mismatch.
  // WS-6.2: DB reachability + LISTEN/NOTIFY round-trip.
  // Imported lazily so this file's top-level imports stay topological.
  const { assertStandardToolHandlersComplete } = await import('./tools/handler-completeness');
  await assertStandardToolHandlersComplete();
  const { assertDatabaseReachable } = await import('./infrastructure/boot-checks');
  await assertDatabaseReachable();

  const server = app.listen(PORT, () => {
    logger.info({ message: `Tenant runtime listening on port ${PORT}` });
  });

  // Web-fetch concurrency infra: dedicated LISTEN client for release events
  // (wakes inflight waiters as soon as a slot frees) + 60s janitor sweep for
  // expired inflight rows, waiters, sessions, and stale token buckets.
  getReleaseEmitter();
  startWebFetchJanitor();

  // Drain observed response shapes to the database on a timer. The gateway
  // records the id-bearing paths of every read that passes it, which is the
  // only way to learn returnsIds — those cannot be derived from an input
  // schema. Until this, they lived in an in-memory Map that a restart threw
  // away, so a night's learning reached nobody.
  startLearnedShapeFlush();

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info({ message: `Received ${signal}, starting graceful shutdown` });
    // One last sample before anything is torn down: a shutdown that turns out
    // to have been a memory kill is exactly the case this exists for.
    logMemorySample();
    stopMemoryMonitor();

    // Deep research durability — drain in-flight outbox/reconciler passes
    // BEFORE closing the HTTP server. Bounded internally to 5s each via
    // stopOutboxDrainer/stopReconciler's await loop. If either was never
    // started (ownsAgentRoutes=false), the stop fn is a no-op.
    try {
      await Promise.all([stopOutboxDrainer(), stopReconciler()]);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'deep_research_shutdown_drain_failed');
    }

    // The census loop holds no lease and each page commits with its cursor, so
    // stopping mid-tick loses nothing: the next start resumes from the last
    // reconciled page.
    stopEnumerationScheduler();

    server.close(async () => {
      logger.info({ message: 'HTTP server closed' });

      // What this process observed of response shapes, written before the
      // process goes — AFTER the server has closed, so no request can add an
      // observation behind the flush's back: intake stopped, in-flight
      // requests finished, then one final pass over whatever is pending.
      // Bounded, never a reason to fail the shutdown, and reported by the
      // flush itself, which knows whether it wrote, timed out or failed.
      await stopLearnedShapeFlush();

      // Per Section 18: Flush and shutdown telemetry
      await shutdownTelemetry();

      // Close the web-fetch LISTEN client + clear the in-memory emitter.
      await shutdownNotifier();

      logger.info({ message: 'Telemetry shutdown complete, exiting' });
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => {
      logger.error({ message: 'Graceful shutdown timed out, forcing exit' });
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// R5 Fix 1: backlog-aware scheduler for chat-thread reaper.
// Cadence: 30 min when idle, 2 min when backlog > 0.
let reaperRemaining = 0;
function scheduleChatReaper(): void {
  const intervalMs = reaperRemaining > 0 ? 2 * 60 * 1000 : 30 * 60 * 1000;
  setTimeout(async () => {
    try {
      const result = await reapStaleChatWorkspaces(
        { maxDurationMs: 30_000 },
        {
          pool: getPoolForService('scheduled-execution'),
          logger: scrubLogger,
        },
      );
      reaperRemaining = result.remaining;
    } catch (err) {
      scrubLogger.warn({
        event: 'interval_reaper_failed',
        err: (err as Error).message,
      });
    }
    scheduleChatReaper();
  }, intervalMs);
}

// R5 Fix 4 / BE-R5-006: startup-ready probe reflects schema readiness + drain.
// Cloud Run startup probe polls this; traffic does not route until ready.
//
// This one stays LATCHED on purpose. It answers "did this instance finish
// coming up", and a startup probe that could go false again would make Cloud
// Run tear down a healthy instance over a transient database blip.
const readinessHandler = (_req: Request, res: Response): void => {
  const ready = isSchemaReady() && drainController.startupReady;
  res.status(ready ? 200 : 503).json({ ready, schemaReady: isSchemaReady(), draining: drainController.isDraining });
};
app.get('/startup-ready', readinessHandler);

// `/ready` asks the question again, live.
//
// The latched answer above is wrong for readiness: an instance whose database
// has gone away, or whose schema was rolled back underneath it, keeps saying
// ready and keeps accepting traffic it cannot serve. The probe is read-only,
// statement-timeout bounded, and cached for a few seconds so health-check
// traffic from every instance cannot become load in its own right.
app.get('/ready', async (_req: Request, res: Response): Promise<void> => {
  const probe = await probeSchema(getPoolForService('readiness')).catch((err: Error) => ({
    dbReachable: false, schemaCurrent: false, error: err.message,
    checkedAt: new Date().toISOString(),
  }));
  // Draining is deliberately NOT a failure here: an instance shedding load is
  // finishing the work it already has, and reporting it unready would take its
  // in-flight requests with it.
  const ready = probe.dbReachable && probe.schemaCurrent && drainController.startupReady;
  res.status(ready ? 200 : 503).json({
    ready,
    schemaReady: probe.schemaCurrent,
    dbReachable: probe.dbReachable,
    draining: drainController.isDraining,
    checkedAt: probe.checkedAt,
    ...(probe.error ? { error: probe.error } : {}),
  });
});

start().catch((err) => {
  logger.error({ error: err.message, stack: err.stack });
  process.exit(1);
});
