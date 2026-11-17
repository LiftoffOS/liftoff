// Liftoff Platform Backend - Control Plane
// Per Section 1: The control plane owns commercial and platform truth

// Per Section 18: Initialize tracing before any other imports
import { initTracing, shutdownTracing } from './infrastructure/tracing';
initTracing();

import express from 'express';
import cors from 'cors';
import { accountsRouter, accountsPublicRouter } from './accounts/router';
import { selfDeleteRouter } from './accounts/self-delete-router';
import { subscriptionsRouter } from './subscriptions/router';
import { entitlementsRouter, entitlementsServiceRouter } from './entitlements/router';
import { tenantsRouter } from './tenants/router';
import { deploymentsRouter } from './deployments/router';
import { modelRegistryRouter, modelRegistryServiceRouter } from './model-registry/router';
import { promptRegistryRouter } from './prompt-registry/router';
import { featureFlagsRouter } from './feature-flags/router';
import { adminRouter } from './admin/router';
import { plansRouter } from './plans/router';
import { meterRouter } from './meters/router';
import { overageRuleRouter } from './overage-rules/router';
import { validatorHooksRouter } from './validator-hooks/router';
import { createBillingProxyRouter } from './billing/billing-proxy';
import { dataManagementRouter } from './data-management/router';
import { tenantPromotionRouter } from './tenant-promotion/router';
import { passkeysRouter } from './passkeys/router';
import { operatorDashboardRouter } from './operator-dashboard/router';
import { proxyRouter as connectorsProxyRouter, createConnectorsProxyRouter } from './connectors';
import { governanceProxyRouter } from './governance';
import { liftoffScoreRouter } from './score';
import { referralsRouter } from './referrals/router';
import {
  router as insightsRouter,
  streamRouter as insightsStreamRouter,
  observationRouter as insightsObservationRouter,
  introRouter as insightsIntroRouter,
} from './insights';
import { registerInsightsTools } from './insights/tools';
import { releaseAllLiveTurnLocks } from './insights/turn-control';
import {
  router as liftoffRouter,
  streamRouter as liftoffStreamRouter,
} from './liftoff';
import { releaseAllLiveTurnLocks as releaseAllLiveLiftoffTurnLocks } from './liftoff/turn-control';

// Populate the insights chat tool registry once at module load. The chat
// service calls getToolDefinitionsForRole() per request against this
// registry — without this call the registry stays empty, the LLM is told
// "(none — the user has no data access tools available)", and the
// assistant truthfully replies that it has nothing to work with.
registerInsightsTools();
import { internalAgentsRouter, internalAgentsServiceRouter, distillRouter, distillInternalAgentStreamRouter } from './internal-agents';
import { canonicalAgentRuntimeRouter } from './internal-agents/canonical-router';
import { memoriesRouter } from './memories/router';
import { knowledgeRouter } from './knowledge';
import { agentTemplatesRouter, initTemplateLoader } from './agent-templates';
import { initTeamPresetLoader } from './agent-templates/team-preset-loader';
import { createWorkforceProxyRouter } from './workforce-plans';
import {
  externalAgentRouter,
  externalAgentInternalRouter,
  discoverExternalAgentStreamRouter,
  rediscoverExternalAgentStreamRouter,
  analyzeManualStreamRouter,
} from './external-agents';
import { oversightRouter, oversightInternalRouter } from './internal-agent-oversight';
import { lateFeedbackInternalRouter } from './hitl-late-feedback/internal-router';
import { wakeSettlementInternalRouter } from './wake-settlement/internal-router';
import { wakeOperatorRouter } from './wake-operator/router';
import { diagnosticsFleetRouter } from './diagnostics-fleet/internal-router';
// Liftoff Switch — import an existing OpenClaw or Hermes installation.
import { sourceMigrationsRouter } from './source-migrations/router';
import { skillBundleInternalRouter } from './internal-api/skill-bundle-router';
// TR → PB: first terminal outcome for an imported routine (service auth).
import { sourceMigrationsInternalRouter } from './source-migrations/first-run-router';
// PR3: dashboard surface for Anchor browser sessions (REST + SSE).
import { browserSessionsRouter } from './browser-sessions/router';
import { browserSessionsStreamRouter } from './browser-sessions/stream-router';
import { personAssignmentsRouter } from './person-assignments';
import { workforceRouter } from './workforce/router';
import { tenantMembersRouter } from './tenant-members';
import { auditLogRouter, securityEventRouter, activityEventsRouter } from './audit-log';
import { agentAuditLogsRouter } from './agent-audit-logs';
import { attachAdminStatus } from './branding/admin-status-middleware';
import { supportDelegationMiddleware } from './support-delegation/middleware';
import { supportDelegationSessionRouter } from './support-delegation/session-router';
import { brandingResponseMiddleware } from './branding/middleware';
import { generatedFilesRouter } from './generated-files/router';
import { chatMediaRouter } from './chat-media/router';
import { correctionRouter } from './corrections/router';
import { claudeCodeProxyRouter } from './claude-code-proxy/router';
import { proxyForwardRouter } from './claude-code-proxy/proxy-forward-router';
import { createByokGatewayRouter } from './byok-gateway/router';
import { byokGatewayInternalRouter } from './byok-gateway/internal-router';
import { logByokManagedVendorBinding } from './tenant-ai-provider-keys/resolution-service';
import { mcpRouter } from './mcp-server/router';
import {
  correlationMiddleware,
  tracingMiddleware,
  authMiddleware,
  // Identity is not tenancy: authMiddleware proves who the caller is,
  // tenantAuthMiddleware proves they belong to the tenant they named.
  tenantAuthMiddleware,
  optionalAuthMiddleware,
  errorMiddleware,
  healthCheck,
  readyCheck,
} from './infrastructure/middleware';
import { log } from './infrastructure/logging';
import { initDatabase, getPool } from './infrastructure/database';
import { reportPricingCoverageAtBoot } from './llm/pricing-coverage';
import { initLLMUsageTracking } from './llm/usage-tracker';
import { initEmbeddingClient } from './embedding/init';
import { initSecrets } from './infrastructure/secrets';
import { initFirebase } from './infrastructure/firebase';
import { accessGateMiddleware } from './auth/accessGate';
import { initAllowedDomains } from './config/allowedDomains';
import { inviteRequestsRouter } from './invite-requests/router';
import { initConnectorServiceCache } from './connectors/connector-service-cache';
import { startEventSubscribers } from './events/subscriber';
import { costAttributionRouter } from './cost-attribution/router';
import { runAnthropicBillingReconciler } from './cost-attribution/ingestion/anthropic-billing-reconciler';
import { runOpenAIBillingReconciler } from './cost-attribution/ingestion/openai-billing-reconciler';
import { runGcpBillingIngester } from './cost-attribution/ingestion/gcp-billing-ingester';

const app = express();

// Trust proxy for Cloud Run (SE-002)
app.set('trust proxy', true);

// Per Section 18: Correlation IDs and tracing middleware
app.use(correlationMiddleware);
app.use(tracingMiddleware);

// Host discipline: hard-partition the URL namespace between the api and
// webhooks subdomains. Mounted immediately after tracing so a 404 still
// emits a structured log line tied to a request ID; mounted before /mcp
// so the MCP raw-body parser doesn't see traffic from webhooks.example.com.
// Reads WEBHOOKS_HOST once at module load (empty string → no-op for dev/test).
import { makeHostDisciplineMiddleware, parseWebhookHosts } from './infrastructure/host-discipline';
app.use(makeHostDisciplineMiddleware(parseWebhookHosts(process.env.WEBHOOKS_HOST)));

// Claude Code Proxy — transparent proxy hot path (/proxy/*)
// Mounted BEFORE CORS and express.json() because Claude Code CLI/Desktop/VS Code
// make direct HTTP (not browser) requests and the Anthropic body must be
// forwarded byte-exact (the router captures it with its own express.raw).
// api.example.com is a Cloud Run domain mapping to platform-backend, so this
// in-process router is the sole ingress that forwards /proxy/* to the private
// (IAM-gated) liftoff-developer-proxy service via OIDC — see proxy-forward-router.ts.
app.use('/proxy', proxyForwardRouter);

// BYO provider-key gateway — the hot path an agent's own SDK talks to (/byok/*).
// Mounted here for the same reasons as /proxy directly above: the vendor body
// must be forwarded byte-exact (the router captures it with its own
// express.raw), and the callers are SDKs rather than browsers, so it belongs
// before CORS and before the app-level JSON parser.
//
// Auth is its own: a short-lived per-run token minted by the internal router
// below, presented the way each vendor's SDK presents a credential. The real
// customer key never leaves the control plane, which is the whole point — see
// byok-gateway/router.ts.
app.use('/byok', createByokGatewayRouter());

// MCP Server — agent-to-agent collaboration for Claude Code instances
// Mounted after /proxy, before CORS. Uses its own express.json() + mcpAuthMiddleware.
// Auth: liftoff_mcp_* (static collab token) or liftoff_oat_* (OAuth access token).
// Not browser-accessible (originGuard blocks Origin header).
app.use('/mcp', mcpRouter);

// MCP OAuth front door (plan v6.1 Phases 2-3) — RFC 9728/8414 discovery and
// the OAuth 2.1 authorization-server endpoints. Mounted pre-CORS and pre-JSON
// parser (the AS router has route-local parsers: urlencoded for token/revoke,
// bounded JSON for register). Everything is gated by MCP_OAUTH_ENABLED.
import { oauthMetadataRouter } from './oauth/metadata-router';
import { oauthAuthorizationServerRouter } from './oauth/authorization-server-router';
import { oauthDeviceRouter } from './oauth/device-router';
app.use(oauthMetadataRouter);
app.use(oauthAuthorizationServerRouter);
app.use(oauthDeviceRouter);

// CORS - allow frontend origins
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://localhost:3000',
      'https://liftoff-react-YOUR_PROJECT_HASH-uw.a.run.app',
      'https://example.com',
    ];
app.use(cors({
  origin: corsOrigins,
  credentials: true,
  // The workspace export names its file in Content-Disposition; without this
  // the browser hides the header and the name would have to be rebuilt
  // client-side.
  exposedHeaders: ['Content-Disposition'],
}));

// Stripe webhooks are handled directly by the billing-stripe-webhook Cloud Run
// service (liftoff-billing). Configure Stripe to post to that service URL
// directly — do NOT route through platform-backend.

// Slack webhook also needs raw body for per-app HMAC signature verification.
// Mounted at the exact /events path so express.raw() doesn't consume the body
// for other /api/agent-chat/slack/* routes (admin, OAuth callback) that need
// express.json(). Must be BEFORE express.json() — same reason as Stripe above.
import { slackWebhookRouter } from './agent-chat/slack-adapter/webhook-router';
app.use('/api/agent-chat/slack/events', express.raw({ type: 'application/json' }), slackWebhookRouter);

// GitHub/GitLab reactivity is polling in the connector-service (github-mcp.ts +
// GitLabClient), not inbound webhooks — the receivers that briefly lived here were
// unreachable behind the /api/connectors/* proxy and have been removed.

// Composio webhook receiver — for triggers we register on composio_managed
// connectors (currently GMAIL_NEW_GMAIL_MESSAGE; will extend to Calendar /
// Outlook / etc. as we wire each). Public-facing, authenticated by HMAC
// signature per the Standard Webhooks spec. Must be BEFORE express.json so
// the raw body is available for HMAC verification.
import { composioWebhookRouter } from './connectors/composio-webhook-router';
app.use(
  '/api/internal/composio-webhook',
  express.raw({ type: '*/*', limit: '5mb' }),
  composioWebhookRouter,
);

import { slackInteractivityRouterExport } from './agent-chat/slack-adapter/interactivity-router';
app.use('/api/agent-chat/slack/interactivity',
        express.raw({ type: 'application/x-www-form-urlencoded' }),
        slackInteractivityRouterExport);

// GitHub App lifecycle webhooks — must be BEFORE express.json() so the raw body
// survives for HMAC verification, and forwarded unauthenticated because GitHub
// carries a signature rather than a bearer token. connector-service recomputes
// the digest over these exact bytes.
//
// Load-bearing rather than supplementary: when a non-owner requests the App,
// `installation.created` is the only signal an owner ever approved it, so a
// rejected delivery strands the install rather than degrading it.
import { connectorGithubWebhookRouter } from './connectors/github-webhook-route';
app.use('/api/connectors/github/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/api/connectors', connectorGithubWebhookRouter);

// Knowledge webhooks — must be BEFORE express.json() so raw body is available for HMAC verification.
// Scope express.raw() to /api/knowledge/webhooks only so it doesn't consume the body for
// /api/knowledge/batch and other CRUD endpoints (which need express.json()).
import { knowledgeWebhookRouter } from './knowledge/webhook-router';
app.use('/api/knowledge/webhooks', express.raw({ type: '*/*' }));
app.use('/api/knowledge', knowledgeWebhookRouter);

// Custom inbound webhooks (per-agent event sources) — raw body needed for HMAC
// verification. Mounted BEFORE express.json(). Hard 1 MiB body cap at the
// edge; per-source overrides re-check the limit in inbound-router.ts.
//
// Mounted at /v1 (not /api/events/custom) and served from a dedicated
// hostname (webhooks.example.com env-specific). Host-discipline middleware
// above rejects /v1/* on the api host and rejects every non-/v1 path on the
// webhook host, so this router never sees traffic on the wrong subdomain.
import { eventSourcesInboundRouter, webhookTenantAdminRouter } from './event-sources';
app.use(
  '/v1',
  express.raw({ type: '*/*', limit: '1mb' }),
  eventSourcesInboundRouter,
);

// Liftoff Switch bundle upload — mounted BEFORE the general parser so it gets
// its own, larger limit. A bundle is a bulk upload by design: one imported
// agent's instructions, skills and memories measured 2 MB on their own, so
// three such team members exceed the 5 MB general default and the upload dies
// with a bare 413 that says nothing about which installation was too big. The
// ceiling is Cloud Run's own HTTP/1 request limit, not a number picked here.
// body-parser is a no-op once req.body is set, so the general parser below
// leaves an already-parsed bundle alone.
app.use('/api/source-migrations/:id/bundle', express.json({ limit: '32mb' }));

// JSON parsing for all other routes
// Limit increased to 5mb to handle large MCP tool definitions (e.g., CoinGecko has 100+ tools)
app.use(express.json({ limit: '5mb' }));

// Passkeys routes - uses optional auth (authenticate endpoints are public, register/list/delete check auth internally)
app.use('/api/passkeys', optionalAuthMiddleware, passkeysRouter);

// Mount BEFORE authMiddleware for service-to-service calls
// The router handles its own auth (service auth for POST, tenant auth for GET)
app.use('/api/agent-audit-logs', agentAuditLogsRouter);

// Generated files — service auth, BEFORE authMiddleware
app.use('/api/generated-files', generatedFilesRouter);

// Chat media — a PERSON's own upload on its way into a message. Mounted here
// beside its sibling and, like it, BEFORE authMiddleware: the upload and
// connector-resolve routes carry authMiddleware themselves, and /claim is a
// service route the workforce service calls with no Firebase token at all.
app.use('/api/chat-media', chatMediaRouter);

// Entitlements service endpoint - tenant-runtime fetches entitlements via service auth
// ── Runtime service surface, under /api/internal ────────────────────────
//
// These are the same router objects as the resource-prefix mounts below; they
// are additionally mounted here so callers can move onto a path that cannot
// collide with a user route.
//
// Mounting a service router on the RESOURCE prefix ahead of the auth gate
// shadows the user router for any overlapping path: Express matches the
// service router first, verifyServiceAuth rejects a browser that has no
// service token, and the request never reaches the handler a signed-in user
// was entitled to. For example, GET /api/deployments/:id answers
// {"error":"Missing X-Service-Auth header"} instead of falling through.
// /api/internal/* has no such failure mode, because the path space is disjoint
// by construction rather than by careful route naming — and it is already the
// house convention by 46 mounts to 5.
//
// The resource-prefix mounts these replaced are gone as of this commit; the
// runtime moved onto these paths first, so nothing was calling the old ones.
// Imported here rather than beside the resource-prefix mounts below: these
// bindings are referenced by the /api/internal mounts on the next lines, and
// an inline import further down the file leaves them in their temporal dead
// zone at that point. That is not a type error — tsc compiles it happily and
// the container dies at boot with 'Cannot access router_29 before
// initialization'.
import { featureFlagsServiceRouter } from './feature-flags/router';
import { promptRegistryServiceRouter } from './prompt-registry/router';
import { deploymentsServiceRouter } from './deployments/router';
app.use('/api/internal/entitlements', entitlementsServiceRouter);
app.use('/api/internal/feature-flags', featureFlagsServiceRouter);
app.use('/api/internal/prompt-registry', promptRegistryServiceRouter);
app.use('/api/internal/deployments', deploymentsServiceRouter);


// Same reason as entitlements above: the tenant runtime calls these with
// X-Service-Auth, which the user routers (mounted after the auth gate) answer
// with 401. Each service router exposes only the routes the runtime calls.
//
// Without them, tenant-scoped feature-flag events fail on 401, retry ten times
// and dead-letter, so a tenant's flag overrides never reach its runtime.
// Global flags return before that fetch, which keeps the failure hidden.

// Internal agents service endpoint - tenant-runtime verifies canonical agent status
app.use('/api/internal-agents', internalAgentsServiceRouter);

// Model registry service endpoint — tenant-runtime fetches authoritative
// routing_policy for cached_model_configs refresh (resync endpoint +
// periodic reconciler). Mirrors entitlements service auth pattern.
// Composes with modelRegistryInternalRouter already mounted at this prefix:
// their routes are disjoint ('/' vs '/tenant/:tenantId/configs').
app.use('/api/internal/model-registry', modelRegistryServiceRouter);

// Canonical agent state for tenant-runtime's reconciler (Layer A periodic
// pull + scheduled-enqueue self-heal). Same verifyServiceAuth token as
// internalAgentsServiceRouter; separate router because its projection is
// reconciler-specific.
app.use('/api/internal/agent-runtime', canonicalAgentRuntimeRouter);
// Service-auth mirror of /api/internal-agent-oversight, called by
// tenant-runtime on cache miss for hitl-enforcement. MUST be mounted BEFORE
// the global authMiddleware below — without that, the per-route
// verifyServiceAuth here is preceded by the Firebase Bearer check, which
// rejects TR's X-Service-Auth header with HTTP 401, which shows up as
// `getOversightSettings: PB fetch failed... HTTP 401: Missing or invalid
// authorization header` in TR agent-service logs.
app.use('/api/internal/oversight', oversightInternalRouter);
// Self-wake settlement (TR → PB): deliver a resumed wake's continuation to its chat surface.
app.use('/api/internal/wake-settlement', wakeSettlementInternalRouter);
// BYO provider keys (TR -> PB): "whose key pays for this run, and how do I
// reach it". Answers 'managed' or hands back a base URL plus a short-lived
// per-run token. Same PLATFORM_CALLBACK_TOKEN service auth as its neighbours,
// and mounted here for the same reason: the per-route verifyServiceAuth must
// not sit behind the global Firebase Bearer check.
app.use('/api/internal/byok', byokGatewayInternalRouter);
app.use('/api/internal/late-feedback', express.json(), lateFeedbackInternalRouter);
app.use('/api/internal/diagnostics', express.json(), diagnosticsFleetRouter);

// Correction Protocol - handles its own auth (service auth for internal, user auth for public)
app.use('/api', correctionRouter);

// External Agent Internal Routes - handles its own service auth (EA-001, EA-002)
app.use('/api', externalAgentInternalRouter);

// Tenant invitation routes - use optional auth so users can view/accept invitations
// These must be mounted BEFORE the global authMiddleware
// These four carry their OWN auth and mount long before the global
// authMiddleware, so the global supportDelegationMiddleware below never sees
// them. They therefore need it explicitly, and tenant-members needs it most:
// /my-memberships decides which workspace the entire dashboard drives off. Left
// out, a support session resolved the OPERATOR'S workspaces, the app selected
// one of those, and every properly delegated call then 403'd because the
// customer is not a member of it — the whole dashboard failed at once.
//
// Deliberately NOT applied to /api/passkeys above: passkey registration must
// keep acting on the operator's own account. See support-delegation/deny-list.ts.
app.use('/api/tenant-members', optionalAuthMiddleware, supportDelegationMiddleware, tenantMembersRouter);
app.use('/api/audit', optionalAuthMiddleware, supportDelegationMiddleware, auditLogRouter);
app.use('/api/audit', optionalAuthMiddleware, supportDelegationMiddleware, securityEventRouter);
app.use('/api/audit', optionalAuthMiddleware, supportDelegationMiddleware, activityEventsRouter);

// Contact form - public endpoint, no auth required

// Mount public router before authMiddleware
// Uses the same CORS origins as the main app (already applied above)
app.use('/api/accounts', accountsPublicRouter);

// Slack OAuth callback — bypass Firebase auth (Slack sends browser redirects, not Bearer tokens)

// Connector OAuth callback — OAuth providers redirect the browser here after authorization.
// Browser redirects carry no Firebase Bearer token; mounted before authMiddleware.
// connector-service validates the request via the state parameter it issued at OAuth start.
import { connectorOAuthCallbackRouter } from './connectors/oauth-callback-router';
app.use('/api/connectors', connectorOAuthCallbackRouter);


// Platform tool callbacks — Tenant Runtime calls back for control-plane data (find-teammates,
// send-agent-message, agent-messages). Service auth, must be BEFORE authMiddleware.
import { platformToolsRouter } from './internal-api/platform-tools-router';
app.use('/api/internal/platform-tools', platformToolsRouter);
// Seeded tool classifications — Tenant Runtime reads the global rows for a
// connector type before its name heuristics when it enumerates a vendor-hosted
// MCP. Service auth, BEFORE authMiddleware.
import { toolClassificationsRouter } from './internal-api/tool-classifications-router';
app.use('/api/internal/tool-classifications', toolClassificationsRouter);
// Maintenance jobs — expire-agent-messages. Service auth, BEFORE authMiddleware.
import { maintenanceRouter } from './maintenance/expire-agent-messages';
app.use('/api/internal/maintenance', maintenanceRouter);
// Connection-pool health — polled by the connection-pool-health scheduler.
// Scheduler OIDC auth, BEFORE authMiddleware.
import { poolHealthRouter } from './internal-api/pool-health-router';
app.use('/api/internal/health', poolHealthRouter);
// Retention cleanup — weekly scheduler. Scheduler OIDC auth, BEFORE authMiddleware.
import { dataManagementInternalRouter } from './data-management/internal-router';
app.use('/api/internal/data-management', dataManagementInternalRouter);
// Web tools — vendor spend monitor + monthly reconciliation. Service auth.
import { webToolsJobsRouter } from './web-tools/router';
app.use('/api/internal/jobs', webToolsJobsRouter);
import { housekeepingRouter } from './jobs/housekeeping-router';
app.use('/api/internal/jobs', housekeepingRouter);
// Feature-flags service-auth mirror — same write surface as the public
// /api/feature-flags router (Firebase JWT), but X-Service-Auth gated for
// ops scripts / CI / cross-service callers. MUST be BEFORE authMiddleware.
import { featureFlagsInternalRouter } from './feature-flags/internal-router';
app.use('/api/internal', featureFlagsInternalRouter);
// The Chief AI Officer's browser. It runs in workforce-service, so it reaches
// the same browser tools Liftoff and the Insights Manager call in-process
// through this service-auth endpoint. MUST be BEFORE authMiddleware: the caller
// is a service holding WORKFORCE_SERVICE_TOKEN, not a person with a Firebase token.
import { assistantBrowserInternalRouter } from './browser-sessions/assistant-internal-router';
app.use('/api/internal', assistantBrowserInternalRouter);
// The workspace actions for the Chief AI Officer: the tool manifest it
// registers at startup, one dispatch as the person it speaks for, and the
// workspace's teams. Same service token, same reason it sits BEFORE
// authMiddleware.
import { workspaceActionsInternalRouter } from './workspace-actions/internal-router';
app.use('/api/internal/workspace-actions', express.json({ limit: '2mb' }), workspaceActionsInternalRouter);
import { internalLLMRouter } from './internal-api/llm-router';
// Internal LLM relay — workforce service routes LLM calls through PB's llmClient
app.use('/api/internal/llm', internalLLMRouter);
import { toolsClassifyRouter } from './internal-api/tools-classify-router';
// Connector onboarding's classification step: connector-service's classify
// script sends tool names and descriptions here (CONNECTOR_SERVICE_TOKEN) and
// gets the categories and effect class the one classifier decides.
app.use('/api/internal/tools/classify', express.json({ limit: '4mb' }), toolsClassifyRouter);
import { usageRecordRouter } from './internal-api/usage-record-router';
// The runtime's per-request usage records (INV-PB-013): Stagehand's model
// calls and every TypeSafe call the runtime makes. PLATFORM_CALLBACK_TOKEN.
app.use('/api/internal/usage/record', express.json({ limit: '256kb' }), usageRecordRouter);
import { accountProfilesInternalRouter } from './internal-api/account-profiles-router';
import { chatNotifyInternalRouter } from './internal-api/chat-notify-router';
// Account display fields for the CAIO chat facepile — workforce-service holds
// team-plan presence in its own database and cannot join `accounts` itself.
// Deliberately NOT under /api/internal/accounts: that prefix already carries the
// HMAC-guarded billing router, and two routers on one prefix means the auth a
// request meets depends on mount order.
app.use('/api/internal/account-profiles', express.json(), accountProfilesInternalRouter);
app.use('/api/internal/chat-notify', express.json(), chatNotifyInternalRouter);

import { harvestInternalRouter } from './internal-api/harvest-router';
// Harvest service — tenant feature flag + connector ownership checks (HARVEST_SERVICE_TOKEN auth).
//
// MUST stay ahead of the '/api/internal/connectors' mount below. That mount
// carries workforceServiceAuth as MOUNT-level middleware, so it runs for every
// path under the prefix whether or not its router has a matching route — and
// harvest's GET /api/internal/connectors/:connectorId/tenant lives under that
// prefix. Mounted after it, every harvest ownership check meets the workforce
// token guard, gets 401, and fail-closed drops the connector event. The whole
// harvest pipeline goes silent and nothing says so.
//
// This is the hazard the /api/internal/account-profiles comment below names:
// two routers on one prefix means the auth a request meets depends on mount
// order. Held by src/__tests__/internal-mount-shadowing.test.ts.
app.use('/api/internal', harvestInternalRouter);

import { workforceServiceAuth } from './internal-api/workforce-service-auth';
// The tenant's connectors, for workforce-service. It was calling /api/connectors
// with its service token in the Authorization header, which authMiddleware
// (mounted below, at /api) rejects as a bad Firebase token — so the CAIO got a
// 401 on every request, fell into its "no connectors" branch, and told people
// with a dozen connected apps that their workspace was empty.
//
// Same proxy the authenticated route uses, so the response shape is identical;
// it strips the inbound Authorization and mints connector-service's own auth, so
// nothing about the caller's credentials travels downstream. Mounted here,
// BEFORE authMiddleware, because the caller is a service and carries no Firebase
// token.
app.use('/api/internal/connectors', workforceServiceAuth, createConnectorsProxyRouter());

import { liftoffMirrorRouter } from './internal-api/mirror-router';
// A CAIO notice that arrives after the Liftoff turn ended. Provisioning finishes
// on a Cloud Tasks path in workforce-service, minutes later; that service owns
// the CAIO's thread but the Liftoff pairing lives in this database, so the copy
// has to be made here. Same service-token guard and the same mount position as
// the connectors proxy above, for the same reason: the caller is a service.
app.use('/api/internal/liftoff', workforceServiceAuth, express.json({ limit: '64kb' }), liftoffMirrorRouter);

import { liftoffSourceConversationRouter } from './internal-api/source-conversation-router';
// The other direction on the same pairing: workforce-service asks for the
// Liftoff conversation a team-plan thread was brought in from, so the Chief AI
// Officer can draft from work the person already did there instead of
// re-interviewing them. Same guard and mount position as the mirror above, on
// a prefix of its own: two routers behind one guarded prefix is the
// mount-shadowing shape internal-mount-shadowing.test.ts exists to forbid.
app.use('/api/internal/source-conversation', workforceServiceAuth, express.json({ limit: '64kb' }), liftoffSourceConversationRouter);

import { liftoffPreviewRouter } from './internal-api/preview-router';
// The inverse edge of the deliverable-first loop: the CAIO asks for a seeded,
// paired Liftoff conversation so the person can see the deliverable before a
// team is built. Same guard, own prefix.
app.use('/api/internal/preview', workforceServiceAuth, express.json({ limit: '64kb' }), liftoffPreviewRouter);

import { outputGuardRouter } from './internal-api/output-guard-router';
// The output guard, for the Chief AI Officer's words: one rubric for every
// assistant on the platform, read here so workforce-service carries no copy.
// Same guard, own prefix; the body is one text block.
app.use('/api/internal/output-guard', workforceServiceAuth, express.json({ limit: '256kb' }), outputGuardRouter);

import { assistantHandoverRouter } from './internal-api/assistant-handover-router';
// The Chief AI Officer brings Liftoff or the Insights Manager into one of its
// conversations: the colleagues run here, on their own tables, and their reply
// streams back to workforce-service, which persists it on the Chief AI
// Officer's thread. Same guard, own prefix; the body is small (a message and
// a note), the response is SSE.
app.use('/api/internal/assistants', workforceServiceAuth, express.json({ limit: '64kb' }), assistantHandoverRouter);

import { capabilityDiscoveryInternalRouter } from './internal-api/capability-discovery-router';
// Ranked building blocks for a structured capability need, for the Chief AI
// Officer's planning. Same guard and mount shape as the source-conversation
// route above, on a prefix of its own.
// Auth is handled inside the router (accepts the workforce OR tenant-runtime
// service token — its two consumers), so no mount-level guard here.
app.use('/api/internal/capability-discovery', express.json({ limit: '64kb' }), capabilityDiscoveryInternalRouter);

import { datasetsParkInternalRouter, PARK_BODY_LIMIT } from './internal-api/datasets-park-router';
// Parking, for the surfaces that do not run in this process. Its own mount
// rather than a route on the capability router above: that one is deliberately
// behind a 64kb body limit, which would 413 exactly the payloads worth parking
// (see datasets-park-router.ts). Auth is handled inside the router, the same
// token comparison the capability routes use, so no mount-level guard here.
app.use('/api/internal/datasets/park', express.json({ limit: PARK_BODY_LIMIT }), datasetsParkInternalRouter);

import { chatSummarizationInternalRouter } from './internal-api/chat-summarization-router';
import { embeddingInternalRouter } from './internal-api/embedding-router';
// Rolling summaries for the CAIO chat, which runs in workforce-service. Serves
// the same src/insights/conversation-summarization the insights chat and the
// agent team-chat already share, so there is one implementation rather than a
// stub over there that never called a model.
app.use('/api/internal/chat-summarization', express.json({ limit: '2mb' }), chatSummarizationInternalRouter);
// Embeddings for the Chief AI Officer's conversation search, whose turns live in
// workforce-service's own database. Mounted beside the summarizer for the same
// reason: one implementation, one embedding space, and the cost attributed here.
app.use('/api/internal/embedding', express.json({ limit: '1mb' }), embeddingInternalRouter);
import { modelRegistryInternalRouter } from './model-registry/model-registry-internal-router';
// Registry snapshot (synced rates + tier-derived branding) — tenant-runtime polls
// this to drive BOTH its cost attribution and its customer-facing model redaction
// from the same single source of truth as PB, with no duplicated static tables.
app.use('/api/internal/model-registry', modelRegistryInternalRouter);
// Per-tenant MCP URL allowlist — tenant-runtime polls this for its URL guard snapshot.
// Service-token auth, MUST be BEFORE authMiddleware.
import { mcpAllowlistRouter } from './internal-api/mcp-allowlist-router';
app.use('/api/internal', mcpAllowlistRouter);
// Custom MCP Servers — service-auth resolver for tenant-runtime tool-gateway dispatch.
// MUST be BEFORE authMiddleware.
import { customMcpServersInternalRouter } from './custom-mcp-servers';
app.use('/api', customMcpServersInternalRouter);
// Unified connection runtime-config endpoint. Single door for the
// execution plane to resolve any /connections row into runtime config,
// keyed by connectors.id. MUST be BEFORE authMiddleware.
import { connectionsInternalRouter } from './connections';
app.use('/api', connectionsInternalRouter);
// Tunnels — service-auth endpoints used by liftoff-tunnel-service + Cloud Scheduler.
// MUST be BEFORE authMiddleware.
import { tunnelsInternalRouter } from './tunnels';
app.use('/api', tunnelsInternalRouter);
// Tunnels — customer-side endpoints called by the docker container in the
// customer's network (authenticated by the per-tenant tunnel token, not by
// service tokens or user JWTs). MUST be BEFORE authMiddleware.
import { tunnelsCustomerRouter } from './tunnels';
app.use('/api', tunnelsCustomerRouter);
import { agentTemplatesInternalRouter } from './agent-templates/internal-router';
import { teamProvisioningRouter } from './team-provisioning/router';
// Internal agent template catalog — workforce service discovers templates via X-Service-Auth
app.use('/api/internal/agent-templates', agentTemplatesInternalRouter);
app.use('/api/internal/team-presets', teamProvisioningRouter);
import { devProxyHookRouter } from './integrations/router';
// developer-proxy webhook — keeps external_agent_integrations shadow table in sync
app.use('/api/internal', devProxyHookRouter);

// Agent-test-harness: PB-side end-to-end probe through runAgentChatTurn.
// X-Service-Auth gated; MUST be BEFORE authMiddleware so internal
// callers (CI / ops smokes) can hit it without a Firebase session.
// See src/test-harness/run-chat-router.ts for the contract.
import { testHarnessRouter } from './test-harness/run-chat-router';
app.use('/api/internal/test-harness', testHarnessRouter);

// Workflow engine internal callback — HMAC auth, BEFORE authMiddleware.
import { workflowInternalRouter } from './workflow-engine/router';
app.use('/api/internal/workflow', workflowInternalRouter);

// Phase 0 billing controls — authenticated via HMAC (billing-controls-internal-router)
// or OIDC (spend-subscriber). Both must be BEFORE authMiddleware.
// spend-subscriber MUST be registered before billingControlsInternalRouter: the controls
// router applies router.use(validateBillingHmac) to ALL routes including /spend-event,
// which would reject Pub/Sub push requests (they carry OIDC tokens, not HMAC headers).
import { billingSpendSubscriberRouter } from './billing/spend-subscriber';
// Router registers full path /api/internal/billing/spend-event internally
app.use('/', billingSpendSubscriberRouter);
// Phase 4 web-tool push subscriber. Same pre-authMiddleware mount as the
// LLM spend-subscriber — OIDC token from Pub/Sub, not Firebase JWT or
// HMAC. Registers full path /api/internal/billing/web-tool-event
// internally.
import { webToolSpendSubscriberRouter } from './billing/web-tool-spend-subscriber';
app.use('/', webToolSpendSubscriberRouter);
import { billingControlsInternalRouter } from './billing/billing-controls-internal-router';
app.use('/api/internal/billing', billingControlsInternalRouter);
// Referral programme, liftoff-billing's half. Same HMAC as the router above and
// mounted beside it, because it exists for the same reason: the invoice that
// settles whether a referral earns is only ever seen on the billing side, and
// the attribution row it settles lives here.
import { referralsInternalRouter } from './referrals/internal-router';
app.use('/api/internal/referrals', referralsInternalRouter);
import { accountsInternalRouter } from './accounts/internal-router';
app.use('/api/internal/accounts', accountsInternalRouter);
// Annual pre-pay allocation reset — OIDC-secured Cloud Scheduler job, BEFORE authMiddleware.
import { annualPlanAllocationResetRouter } from './jobs/annual-plan-allocation-reset';
app.use('/api/internal', annualPlanAllocationResetRouter);

// Subscription-ending 7-day / 1-day reminder emails — daily Cloud Scheduler.
import { subscriptionEndingRemindersRouter } from './jobs/subscription-ending-reminders';
app.use('/api/internal', subscriptionEndingRemindersRouter);

// Invitation-expiry sweep — daily Cloud Scheduler. Flips lapsed invitations to
// 'expired' and emails each inviter one aggregated re-invite notice.
import { inviteExpirySweepRouter } from './jobs/invite-expiry-sweep';
app.use('/api/internal', inviteExpirySweepRouter);
// Daily referral signup sweep — marks signups that have gone the horizon
// without converting. Presentational only: a late conversion still earns.
import { referralSignupExpiryRouter } from './jobs/referral-signup-expiry';
app.use('/api/internal', referralSignupExpiryRouter);
import { capabilityBlueprintVerifyRouter } from './jobs/capability-blueprint-verify';
// Targeted re-verification of adopted external refs (never a catalog sweep);
// run manually or by Cloud Scheduler once blueprints accumulate.
app.use('/api/internal', capabilityBlueprintVerifyRouter);

// Invitation reminder — daily Cloud Scheduler. Reminds a recipient ~48h before
// their pending invitation expires, once, with a second accept link that leaves
// the original valid.
import { inviteReminderSweepRouter } from './jobs/invite-reminder-sweep';
app.use('/api/internal', inviteReminderSweepRouter);
// Finishes imports whose conversion ran out of hourly distillation allowance.
// Without it a large import converts part of a team and then looks finished.
import { sourceMigrationResumeSweepRouter } from './jobs/source-migration-resume-sweep';
app.use('/api/internal', sourceMigrationResumeSweepRouter);

// Hourly re-fire of failed OU meter events captured by fireOuMeterEventDurable
// (cost-attribution path has no other recovery — see migration 329).
import { ouMeterRetryDrainRouter } from './jobs/ou-meter-retry-drain';
app.use('/api/internal', ouMeterRetryDrainRouter);
import { ouMeterReconcileRouter } from './jobs/ou-meter-reconcile';
app.use('/api/internal', ouMeterReconcileRouter);

// x402 wallet treasury checks (plan step 7): hourly balance floor, daily
// on-chain reconciliation against the x402_wallet_funded ledger. Both are
// no-ops (skipped, 200) until X402_WALLET_ADDRESS is set.
import { x402LowBalanceRouter } from './jobs/x402-low-balance';
app.use('/api/internal', x402LowBalanceRouter);
import { x402ReconcileRouter } from './jobs/x402-reconcile';
app.use('/api/internal', x402ReconcileRouter);
import { x402ReloadRouter } from './jobs/x402-reload';
app.use('/api/internal', x402ReloadRouter);
import { x402TopupRouter } from './jobs/x402-topup';
app.use('/api/internal', x402TopupRouter);
import { x402ApifyTokenRouter } from './jobs/x402-apify-token';
app.use('/api/internal', x402ApifyTokenRouter);

import { extractKnowledgeContentRouter } from './jobs/extract-knowledge-content';
app.use('/api/internal', extractKnowledgeContentRouter);

// WS-A1: wrap res.json on internal endpoints so 4xx bodies carrying a
// zod `issues` array also emit a structured log line. The middleware is
// mounted on prefix-matched paths BEFORE the router itself.
import { captureZodIssueResponses } from './infrastructure/zod-issue-logger';

import { knowledgeInternalRouter } from './knowledge/internal-router';
app.use('/api/internal/knowledge', captureZodIssueResponses);
app.use('/api/internal/knowledge', knowledgeInternalRouter);

import { embedKnowledgeContentRouter } from './jobs/embed-knowledge-content';
app.use('/api/internal', embedKnowledgeContentRouter);

import { renewKnowledgeWebhooksRouter } from './jobs/renew-knowledge-webhooks';
app.use('/api/internal', renewKnowledgeWebhooksRouter);

import { syncDropboxFoldersRouter } from './jobs/sync-dropbox-folders';
app.use('/api/internal', syncDropboxFoldersRouter);

// Phase 4 backfill: parse [[knowledge:...]] markers on existing agents,
// populate pinned_knowledge_ids, strip legacy ## Knowledge systemPrompt section.
import { backfillPinnedKnowledgeRouter } from './jobs/backfill-pinned-knowledge';
app.use('/api/internal/backfill-pinned-knowledge', backfillPinnedKnowledgeRouter);

// Slack — internal scheduler job (OIDC, BEFORE authMiddleware) + admin routes (after).
import { slackAdminRouter } from './agent-chat/slack-adapter/admin-routes';

// Per-agent Slack tool surface — service-auth'd RPC consumed by tenant-
// runtime's slack-tool-handler. Provides install lookups (with resolved
// bot tokens) and channel-binding CRUD.
import { agentSlackInternalRouter, slackWorkspaceInstallRouter, slackWorkspaceEventRouter } from './agent-chat/slack-adapter/internal-router';
// These two mount BEFORE the general router: they authenticate with
// PLATFORM_CALLBACK_TOKEN (connector-service), not AGENT_SLACK_SERVICE_TOKEN.
app.use('/api/internal/agent-slack/workspace-install', slackWorkspaceInstallRouter);
app.use('/api/internal/agent-slack/workspace-event', slackWorkspaceEventRouter);
app.use('/api/internal/agent-slack', agentSlackInternalRouter);

// Microsoft Teams adapter — bot messaging endpoint (Bot Framework JWT auth via
// the CloudAdapter), OAuth admin-consent callback (browser redirect), and the
// service-auth'd internal RPC consumed by tenant-runtime's agent-teams-handler.
// All mounted AFTER the global express.json() (line 208) and BEFORE
// authMiddleware. The tenant-member admin router is mounted after authMiddleware.
import { teamsMessagesRouter } from './agent-chat/teams-adapter/messages-router';
import { teamsOAuthCallbackRouter } from './agent-chat/teams-adapter/oauth-callback-router';
import { agentTeamsInternalRouter } from './agent-chat/teams-adapter/internal-router';
app.use('/api/agent-chat/teams/messages', teamsMessagesRouter);
app.use('/api/agent-chat/teams', teamsOAuthCallbackRouter);
app.use('/api/internal/agent-teams', agentTeamsInternalRouter);

// Notifications — public unsubscribe + internal enqueue/run-tick/newsletter,
// both BEFORE authMiddleware (the public router uses HMAC-signed tokens, the
// internal router uses X-Service-Auth). The authed inbox lookup is mounted
// after authMiddleware further down.
import {
  notificationsAuthedRouter,
  notificationsPublicRouter,
  notificationsInternalRouter,
} from './notifications';
import { pushAuthedRouter } from './push';
app.use('/api/notifications', notificationsPublicRouter);
// WS-A1: capture zod-issue 400s on the internal notifications endpoints. The
// router lives under /api/internal but only its /notifications/* routes are
// wrapped — other /api/internal routers manage their own validation paths.
app.use('/api/internal/notifications', captureZodIssueResponses);
app.use('/api/internal/newsletter', captureZodIssueResponses);
app.use('/api/internal', notificationsInternalRouter);

// MCP chat-run worker (plan v6.1 Phase 5b) — Cloud Tasks delivery target,
// OIDC-authed by the mcp-chat-runs queue SA. Pre-authMiddleware: service
// auth, not user auth.
import { mcpChatRunWorkerRouter } from './mcp-server/chat-run-worker';
app.use('/api/internal/mcp-chat-runs', mcpChatRunWorkerRouter);

// Chat-turn worker (Slack + Teams): Cloud Tasks delivery target so inbound chat
// turns run inside their own request instead of detached post-ack compute.
import { chatTurnWorkerRouter } from './agent-chat/chat-turn-worker';
app.use('/api/internal/chat-turns', chatTurnWorkerRouter);
import { redistillAcceptWorkerRouter } from './agent-chat/redistill-accept-worker';
// The background half of accepting a routine proposal: the redistill runs in
// its own request (same queue, same guard as the worker above) and the person
// is told in-thread when it is live.
app.use('/api/internal/chat-turns', redistillAcceptWorkerRouter);

// TR→PB chat-turn settle callback: disconnect-proof persistence backstop for
// completed chat turns whose SSE consumer vanished.
import { settleTurnRouter } from './agent-chat/settle-turn-router';
import { browserTaskInternalRouter } from './chat-continuations/browser-task-router';
app.use('/api/internal/agent-chat', settleTurnRouter);
app.use('/api/internal/browser-tasks', browserTaskInternalRouter);
import { escalationThreadRouter } from './agent-chat/escalation-thread-router';
app.use('/api/internal/agent-chat', escalationThreadRouter);
import { routineProposalRouter } from './agent-chat/routine-proposal-router';
import { colleagueRequestRouter } from './agent-chat/colleague-request-router';
import { colleagueWorkerRouter } from './agent-chat/colleague-worker';
// The runtime's propose_routine tool: a person asked their team member for
// standing behaviour in chat, and the proposal lands on the consent rail the
// teaching path already uses. Same callback secret as the two routes above.
app.use('/api/internal/agent-chat', routineProposalRouter);
app.use('/api/internal/agent-chat', colleagueRequestRouter);
app.use('/api/internal/chat-turns', colleagueWorkerRouter);

// Authentication middleware for all API routes (except webhooks, passkeys, OAuth, internal
// service-auth routes, and tenant-members handled above).
// Internal routes use their own authentication (HMAC, OIDC, or service tokens) and
// must NOT require Firebase JWT. Skip them here.
app.use('/api', (req, res, next) => {
  // Skip auth for internal service endpoints that use their own auth
  if (req.path.startsWith('/internal/')) {
    return next();
  }
  return authMiddleware(req, res, next);
});

// Support delegation ("become user"). Mounted immediately after authMiddleware,
// which has just proved WHO IS CALLING, and before accessGateMiddleware, so the
// gate evaluates the identity the request is being ANSWERED as. A request with
// no x-act-as header passes straight through unchanged.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/internal/')) return next();
  return supportDelegationMiddleware(req, res, next);
});

// "Which support session is this?" for the banner. Mounted in the same window
// as the two routers below, so a session opened on a customer who is still
// behind the access gate can still label itself.
app.use('/api/support-delegation', supportDelegationSessionRouter);

// Notifications inbox — mounted BETWEEN authMiddleware and accessGateMiddleware so
// invite-pending / non-granted users can still see their own queue. The query
// is naturally scoped by req.user.uid → account.id, so leaking via this route
// is impossible.
app.use('/api/notifications', notificationsAuthedRouter);

// Browser push subscriptions — mounted in the same window and for the same
// reason. Every query is scoped by req.user.uid -> account.id, and somebody
// whose access is still pending must still be able to unsubscribe a device.
app.use('/api/push', pushAuthedRouter);

// Access gate middleware — blocks non-granted users from protected API routes
// Whitelisted endpoints: GET /api/accounts/me, POST /api/accounts, POST /api/invite-requests
app.use('/api', accessGateMiddleware);

// Invite requests — whitelisted from access gate for ungated users
app.use('/api/invite-requests', inviteRequestsRouter);

// MCP OAuth consent API (plan v6.1 Phase 3) — Firebase-authed pair behind
// the frontend /oauth/consent page. Covered by app.use('/api', authMiddleware).
import { oauthConsentRouter } from './oauth/consent-router';
app.use('/api/oauth', oauthConsentRouter);

// Claude Code Proxy management — key CRUD, MCP token issuance, PKCE setup exchange
// Mounted after authMiddleware so Firebase JWT is required.
app.use('/api/claude-code-proxy', claudeCodeProxyRouter);

// Control plane routes per Section 1
app.use('/api/accounts', accountsRouter);
app.use('/api/accounts', selfDeleteRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/entitlements', entitlementsRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/deployments', tenantAuthMiddleware('viewDashboard'), deploymentsRouter);
app.use('/api/model-registry', attachAdminStatus, brandingResponseMiddleware, modelRegistryRouter);
app.use('/api/prompt-registry', tenantAuthMiddleware('viewDashboard'), promptRegistryRouter);
app.use('/api/feature-flags', tenantAuthMiddleware('viewDashboard'), featureFlagsRouter);
app.use('/api/admin', adminRouter);
// Per Section 13: Plans for billing
app.use('/api/plans', plansRouter);
app.use('/api/meters', meterRouter);
app.use('/api/overage-rules', tenantAuthMiddleware('viewDashboard'), overageRuleRouter);
// Per Section 17: Validator hooks for LLM management
app.use('/api/validator-hooks', tenantAuthMiddleware('viewDashboard'), validatorHooksRouter);
// Billing — all /api/billing/* forwarded unconditionally to liftoff-billing.
app.use('/api/billing', createBillingProxyRouter());
// Per Section 21: SOC 2/GDPR data management
app.use('/api/data-management', tenantAuthMiddleware('viewDashboard'), dataManagementRouter);
// Per Section 22 Phase 5: Tenant promotion tooling
app.use('/api/tenant-promotion', tenantPromotionRouter);
// Per Section 17: Operator dashboard for control-plane visibility
app.use('/api/operator', operatorDashboardRouter);
// External agent integration metadata — served from local DB, never calls developer-proxy
import { integrationsRouter } from './integrations/router';
app.use('/api/integrations', integrationsRouter);
// Per Phase 2a: /api/connectors/* forwards to connector-service via proxy.
// Legacy in-process CRUD/OAuth/apikey/keypair routers have been deleted.
//
// CHANGING a connection is owner/admin; READING the list is any member. The
// prefix carries both, so the guard is on the method rather than the mount:
// a blanket guard would take the Connections page away from the members and
// viewers who are meant to see it.
//
// It is `manageConnectors` rather than a role floor because that is the
// capability the sibling connector routers already name
// (custom-mcp-servers, custom-api-connectors), so the four families answer
// the same question the same way. The assistant path enforces the equivalent
// `connections:manage` inside workspace-actions; until now the dashboard's
// HTTP path enforced nothing at all, not even membership, so the same act was
// owner/admin in chat and open to any signed-in caller over HTTP.
//
// Every write reaching here carries its tenant id in the query or the body
// (oauth start, apikey connect, keypair setup/verify, IAM grant, GitHub App
// install-start, disconnect, status change), and the guard resolves it from
// either. A write that names no tenant is refused rather than forwarded.
app.use('/api/connectors', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  tenantAuthMiddleware('manageConnectors')(req, res, next);
});
app.use('/api/connectors', connectorsProxyRouter);
// Per Phase 3: /api/governance/* forwards to governance-engine via proxy.
// Covers /approvals, /actions, /usage, /audit, /late-feedback dashboards.
app.use('/api/governance', governanceProxyRouter);
// LiftoffScore — per-team and per-person collaboration ratings.
// tenantAuthMiddleware first: this is a NAMED measurement surface, so tenant
// membership and role are verified here rather than trusted from the request.
// 'viewAuditLogs' is owner+admin and false for member, matching the frontend's
// canManageMembers() gate.
app.use('/api/score', tenantAuthMiddleware('viewAuditLogs'), liftoffScoreRouter);
// Workspace data export — Settings → Workspace → Export Workspace Data.
// Validation first, on the mount: tenantAuthMiddleware resolves membership
// with whatever `?tenantId` holds, so a missing id would be a 403 and a
// malformed one a 500 instead of the 400 both deserve. Then membership and
// the exportWorkspaceData permission (owner and admin), then the router.
import { requireTenantIdQuery, workspaceExportRouter } from './workspace-export/router';
app.use('/api/workspace-export', requireTenantIdQuery, tenantAuthMiddleware('exportWorkspaceData'), workspaceExportRouter);
// Referral programme — /dashboard/refer.
// tenantAuthMiddleware first, so the tenant id the page sends is proved to
// belong to the caller before anything reads a workspace's referrals or sends
// mail on its behalf. 'viewDashboard' is true for every role, matching where
// the page sits: anyone who can see the workspace can share its link. What a
// referral is WORTH still comes from liftoff-billing on every request — this
// plane never computes a money figure of its own (INV-PB-010).
app.use('/api/referrals', tenantAuthMiddleware('viewDashboard'), referralsRouter);
// Agent Templates — read-only catalog API
app.use('/api/agent-templates', agentTemplatesRouter);
// Internal Agents API
// captureZodIssueResponses first: a rejected create/update answers 400 with the
// failing fields in the response body and logged nothing, so the only record of
// WHICH field failed went to the browser. A team that could not be launched was
// therefore undiagnosable from the server side.
app.use('/api/internal-agents', captureZodIssueResponses, attachAdminStatus, brandingResponseMiddleware, internalAgentsRouter);
// Layer-scoped memories CRUD proxy — all memory layers (global, role, individual)
app.use('/api/memories', memoriesRouter);
// Knowledge base CRUD + connector browse/import/sync
app.use('/api/knowledge', knowledgeRouter);
// Internal Agents Distill - LLM-powered configuration generation
app.use('/api/internal-agents/distill', tenantAuthMiddleware('viewDashboard'), distillRouter);
// Internal Agents Distill Stream - SSE endpoint for progress updates
app.use('/api/internal-agents/distill-stream', tenantAuthMiddleware('viewDashboard'), distillInternalAgentStreamRouter);
// Tenant-level webhook admin (caps + DSAR). Per-agent webhook management is
// nested under internalAgentsRouter, but these endpoints aren't tied to a
// single agent so they live at the module root.
app.use('/api/event-sources', webhookTenantAdminRouter);
// Workforce Plans + Team Plan — forwarded to liftoff-workforce-service.
// 503s gracefully when WORKFORCE_SERVICE_URL is not set (e.g. prod before cutover).
const workforceProxy = createWorkforceProxyRouter();
app.use('/api/workforce-plans', workforceProxy);
app.use('/api/team-plan', workforceProxy);
// External Agents API
app.use('/api/external-agents', externalAgentRouter);
// External Agents Discover Stream - SSE endpoint for MCP discovery progress
app.use('/api/external-agents/discover-stream', tenantAuthMiddleware('viewDashboard'), discoverExternalAgentStreamRouter);
// External Agents Rediscover Stream - SSE endpoint for re-discovering existing agents
app.use('/api/external-agents/rediscover-stream', tenantAuthMiddleware('viewDashboard'), rediscoverExternalAgentStreamRouter);
// External Agents Analyze Manual Stream - SSE endpoint for manual capability analysis
app.use('/api/external-agents/analyze-manual-stream', tenantAuthMiddleware('viewDashboard'), analyzeManualStreamRouter);
// Custom MCP Servers — tools-only consumer of the shared MCP plumbing.
// Authenticated by authMiddleware above.
import { customMcpServersRouter } from './custom-mcp-servers';
app.use('/api/custom-mcp-servers', tenantAuthMiddleware('viewDashboard'), customMcpServersRouter);
// Custom API connections — the capture page's read and its submit. Every
// route carries tenantAuthMiddleware('manageConnectors') of its own, which
// is what re-checks the permission at SUBMIT: a role can change inside the
// hour a capture link lives, and the mint's check is an hour old by
// construction.
import { customApiConnectorsRouter } from './custom-api-connectors/router';
app.use('/api/custom-api-connectors', customApiConnectorsRouter);
// Tunnels — shared infrastructure consumed by Custom MCP Servers and External Agents.
// CRUD over deployments + routes + token rotation. Authenticated by authMiddleware above.
import { tunnelsRouter } from './tunnels';
app.use('/api', tunnelsRouter);
// Internal Agent Oversight Settings - HITL configuration per tenant
// (user-facing; the service-auth mirror `oversightInternalRouter` is
// mounted above, BEFORE authMiddleware, so service callers can hit
// /api/internal/oversight/:tenantId without a Firebase Bearer token.)
app.use('/api/internal-agent-oversight', oversightRouter);
// Self-wake operator surface (tenant-admin auth; proxies to TR).
app.use('/api/wakes', wakeOperatorRouter);
// Liftoff Switch — create/resume a migration, upload a redacted bundle,
// convert after payment, and activate on explicit cutover confirmation.
// Internal (service-auth) mounted BEFORE the tenant-auth router so the more
// specific prefix wins on route matching.
app.use('/api/internal/source-migrations', sourceMigrationsInternalRouter);
app.use('/api/source-migrations', sourceMigrationsRouter);
// Skill bundle files, read by the runtime to materialize them into a sandbox.
// Service-auth; the global /api gate skips /internal/ paths.
app.use('/api/internal', skillBundleInternalRouter);
// Person-to-Agent Assignments - assign personnel to AI agents
app.use('/api/person-assignments', personAssignmentsRouter);
// Unified workforce aggregation for /teams page — all agent types + personnel in one call
app.use('/api/teams/workforce', workforceRouter);
// Note: tenant-members router is mounted earlier with optionalAuthMiddleware
// Note: /api/connectors/* (including /health, /oauth, /apikey, /keypair) is
// forwarded to connector-service by connectorsProxyRouter mounted above.
// Cost Attribution API — per-tenant, per-agent cost breakdowns
app.use('/api/cost-attribution', costAttributionRouter);

// Insights - analytics dashboard and chat
app.use('/api/insights', insightsRouter);
// Insights chat streaming (SSE) — separate router so SSE headers / flushHeaders
// don't interact with the JSON-focused middleware on the main insights router.
app.use('/api/insights', insightsStreamRouter);
// PR3: Browser sessions REST + SSE bridge. Routes are prefix-agnostic
// (/threads/:id/browser-sessions and /browser-sessions/:id) so mount under /api.
app.use('/api', browserSessionsRouter);
app.use('/api', browserSessionsStreamRouter);
// Insights observations streaming (SSE) — Phase 7, LLM-generated key
// observations layered on top of the instant-load report.
app.use('/api/insights', tenantAuthMiddleware('viewDashboard'), insightsObservationRouter);
// Insights intro streaming (SSE) — LLM-generated one-paragraph summary
// that renders above the metric cards.
app.use('/api/insights', tenantAuthMiddleware('viewDashboard'), insightsIntroRouter);

// Liftoff - the general platform assistant behind the dashboard composer
app.use('/api/liftoff', liftoffRouter);
// Liftoff chat streaming (SSE), a separate router for the same reason the
// insights one is separate: SSE headers / flushHeaders don't interact with the
// JSON-focused middleware on the main router.
app.use('/api/liftoff', liftoffStreamRouter);

// Agent chat — interactive mode (Phase 2 + Phase 4)
import { agentChatRouter } from './agent-chat/router';
import { agentChatStreamRouter } from './agent-chat/stream-router';
import { participantRouter } from './agent-chat/participant-router';
app.use('/api/agent-chat', agentChatRouter);
app.use('/api/agent-chat', agentChatStreamRouter);
app.use('/api/agent-chat', participantRouter);

// Voice dictation is a WebSocket, attached to the HTTP server further down
// rather than mounted as a router: the composer shows words while they are being
// spoken, and a request cannot be answered before its body ends.
import { attachVoiceListenWebSocket } from './voice/listen-ws';
import { attachVoiceSpeakWebSocket } from './voice/speak-ws';

// Chat share links — workspace-scoped /share/<id> deep links for agent chat.
// Covered by the global authMiddleware + accessGateMiddleware above.
import { chatSharesRouter } from './chat-shares/router';
app.use('/api/chat-shares', chatSharesRouter);

// Chat History across every surface — the "All" view of the web app's history
// modal. Covered by the global authMiddleware + accessGateMiddleware above.
import { chatThreadsRouter } from './chat-threads/router';
app.use('/api/chat-threads', chatThreadsRouter);

// Notification links — resolve an opaque /notification/<id> to its destination.
// Same window and same access model as chat-shares: membership is the floor and
// every failure answers with one indistinguishable 404.
import { notificationLinksRouter } from './notification-links';
app.use('/api/notification-links', notificationLinksRouter);

// Slack adapter — admin routes (Phase 3)
// Webhook + OAuth callback are mounted before authMiddleware (see above).
app.use('/api/agent-chat/slack', slackAdminRouter);

// Teams adapter — admin routes (connect-url + install-status), tenant-member
// auth, mounted after authMiddleware (messages/oauth-callback/internal are
// mounted before authMiddleware above).
import { teamsAdminRouter } from './agent-chat/teams-adapter/admin-routes';
app.use('/api/agent-chat/teams', teamsAdminRouter);

// A2A — Agent-to-Agent protocol (Google/Linux Foundation standard wire format)
// Tenant-scoped: agents only callable within the same workspace.
// agentCardRouter uses Firebase JWT (same as other API routes).
// a2aRpcRouter uses Firebase JWT for now; X-Service-Token added in future sprint.
import { agentCardRouter } from './a2a/agent-card-router';
import { a2aRpcRouter } from './a2a/rpc-router';
app.use('/api/a2a', agentCardRouter);
app.use('/api/a2a', a2aRpcRouter);

// Workflow engine — durable cross-agent workflows.
import { workflowDefinitionsRouter, workflowRunsRouter } from './workflow-engine/router';
app.use('/api/workflow-definitions', tenantAuthMiddleware('viewDashboard'), workflowDefinitionsRouter);
// Starting a run dispatches agents, so it takes converseWithAgents rather
// than viewDashboard — which every role holds, and which therefore guarded the
// prefix without restricting anybody. Listing runs is a read and stays open to
// every member.
app.use('/api/workflow-runs', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    tenantAuthMiddleware('viewDashboard')(req, res, next);
    return;
  }
  tenantAuthMiddleware('converseWithAgents')(req, res, next);
}, workflowRunsRouter);

// Health and readiness checks
app.get('/health', healthCheck);
app.get('/ready', readyCheck);

// WS-9.6 — Express-route introspection for the CI scheduler-target
// validator. Service-auth gated; no public exposure of route inventory.
//
// Walks the router stack recursively: Express creates two layer shapes —
// leaf routes (layer.route set) and sub-routers mounted via
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
  if (req.headers['x-service-auth'] !== process.env.PLATFORM_CALLBACK_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
   
  const stack = (app as any)._router?.stack ?? [];
  res.json({ routes: collectRoutes(stack) });
});

// Error handling
app.use(errorMiddleware);

const PORT = process.env.PORT || 8080;

// Initialize and start server
async function start(): Promise<void> {
  try {
    // Hydrate secrets into process.env BEFORE anything else. The rest of
    // the codebase reads process.env.X synchronously throughout — none of
    // those values are bound to Cloud Run as env vars (cloudbuild has no
    // --set-secrets flag, Terraform doesn't manage Cloud Run env value
    // sources). See infrastructure/secrets.ts SECRET_MANIFEST and the
    // comment block on loadSecretsToEnv() for the full rationale.
    await initSecrets();

    // Initialize Firebase Admin SDK for token verification.
    //
    // In Cloud Run (dev + prod) we use Application Default Credentials — the
    // runtime service account, which has roles/firebase.admin granted on the
    // YOUR_WEB_PROJECT project (where the Firebase Auth users live). No secret
    // is fetched; if a future ops change ever wants per-env Firebase keys, the
    // FIREBASE_SERVICE_ACCOUNT env var path in initFirebase() still works
    // and would take precedence.
    //
    // Local dev: developers run `gcloud auth application-default login` with
    // an identity that has Firebase Admin on YOUR_WEB_PROJECT (or set
    // FIREBASE_SERVICE_ACCOUNT=<path to JSON> for an explicit key).
    await initFirebase(process.env.FIREBASE_SERVICE_ACCOUNT);

    // Per Section 5: Initialize database connection pool
    await initDatabase();

    // Model-pricing loader — reads synced open-weights rates (model_pricing table,
    // migration 285) into memory on a 15-min TTL so computeRowCost() can consult
    // DB-sourced rates synchronously. Falls back to static MODEL_PRICING until the
    // first load succeeds; never blocks boot.
    import('./llm/model-pricing-loader').then(({ startModelPricingRefresh }) => {
      startModelPricingRefresh();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start model-pricing loader'),
    );

    // Tier→model loaders — drive tier resolution from the models registry (60s
    // refresh) so a new model/tier is a registry row, not a code edit. The
    // per-provider maps are kicked off inside LLMClient.init() (and, for
    // OpenRouter, inside createOpenRouter()); nothing to wire here for those.
    //
    // The Workspace AI vendor map is the third place model names lived and has
    // no provider to hang off, so it starts here.
    import('./model-registry/workspace-ai-vendor-loader').then(({ startWorkspaceAiVendorRefresh }) => {
      startWorkspaceAiVendorRefresh();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start workspace AI vendor loader'),
    );

    // The four platform vendor levers. A 60s BACKSTOP poll, not the delivery
    // mechanism: an admin write installs the change in its own process at once
    // and publishes platform.vendor_policy.updated for the runtime, so this
    // only bounds how long a lost push can leave a lever stale.
    import('./model-registry/platform-vendor-policy-loader').then(({ startPlatformVendorPolicyRefresh }) => {
      startPlatformVendorPolicyRefresh();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start platform vendor policy loader'),
    );

    // Registry-derived branding overlay — model_id→codename (by tier) from the
    // models registry, so registry-onboarded models are redacted without a branding
    // file edit. 60s refresh; falls back to static maps until the first load.
    import('./branding/registry-branding-loader').then(({ startRegistryModelBrandingRefresh }) => {
      startRegistryModelBrandingRefresh();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start registry branding loader'),
    );

    // Provisioning-outbox worker — runs on every instance with a 30s fallback
    // poll. In-process kicks (via TenantService.activate on failure) trigger
    // immediate execution. Multiple instances are safe via SELECT FOR UPDATE
    // SKIP LOCKED on row claim.
    import('./billing/provisioning-outbox-worker').then(({ startProvisioningOutboxLoop }) => {
      startProvisioningOutboxLoop();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start provisioning-outbox worker'),
    );

    // Internal-agent + generic control-plane outbox workers (plan §5.5).
    // Both poll every 30s and only drain rows where inline publish failed.
    // Steady state in-flight is near-zero; the workers are the recovery path.
    import('./internal-agents/outbox').then(({ startInternalAgentOutboxWorker }) => {
      startInternalAgentOutboxWorker();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start internal-agent-outbox worker'),
    );
    import('./events/outbox').then(({ startControlPlaneOutboxWorker }) => {
      startControlPlaneOutboxWorker();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start control-plane-outbox worker'),
    );
    import('./knowledge/outbox').then(({ startKnowledgeOutboxWorker }) => {
      startKnowledgeOutboxWorker();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start knowledge-outbox worker'),
    );
    import('./hitl-late-feedback/trust-outbox').then(({ startLateFeedbackTrustOutboxWorker }) => {
      startLateFeedbackTrustOutboxWorker();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start late-feedback-trust-outbox worker'),
    );

    // The purge pass that makes a deletion final. Started here rather than
    // left to a scheduler because "deleted" is a promise the product makes to
    // a person, and a deployment that never created the scheduler would keep
    // every soft-deleted row for ever while still reporting success. An
    // advisory lock makes running it on every instance the same as running it
    // on one.
    import('./maintenance/purge-soft-deleted').then(({ startPurgeWorker }) => {
      startPurgeWorker();
    }).catch((err) =>
      log.error({ error: (err as Error).message }, 'Failed to start soft-delete purge worker'),
    );

    // Load allowed domains for access gate — must be after Firebase init
    await initAllowedDomains();

    // Seed the connector-service RPC cache BEFORE the template loader runs.
    // The loader reads FUNCTIONAL_CONNECTOR_TYPES and capability maps to
    // decide which templates are available, so the cache must be hot by
    // then. When CONNECTOR_SERVICE_ENABLED=off or the RPC is unreachable,
    // the cache seeds from the static fallback — no boot failure.
    await initConnectorServiceCache();

    // Initialize agent template loader — reads YAML catalog at startup.
    // Schema-fatal violations crash boot; non-fatal ones disable the template.
    initTemplateLoader();
    // Team presets (bundles of roles provisioned together) load from their own dir.
    initTeamPresetLoader();

    // Track every LLM call — must be registered after DB init, before any LLM usage
    initLLMUsageTracking();
    await initEmbeddingClient();

    // Say which vendor 'Liftoff Managed' routes to, so a customer's key for that
    // vendor being what funds those workspaces is a stated fact rather than a
    // consequence of an internal constant nobody reads. Moving that constant is
    // a billing change: it silently returns every Liftoff Managed tenant's spend
    // to Liftoff. This line is what makes the move visible in the logs.
    logByokManagedVendorBinding();

    // Billing invariant diagnostic — logs (does not throw) for any enterprise
    // tenant whose subscriptions row is missing. Surfaces drift caused by raw
    // SQL provisioning instead of the admin provision-enterprise endpoint.
    import('./billing/startup-checks').then(({ logEnterpriseSubscriptionDrift }) =>
      logEnterpriseSubscriptionDrift(),
    ).catch(() => {});

    // Workflow state recovery — re-dispatch stale steps from previous instance
    import('./workflow-engine/state-recovery').then(({ recoverStaleSteps }) => {
      recoverStaleSteps().catch(err =>
        log.error({ error: (err as Error).message }, 'workflow state-recovery: startup sweep failed'),
      );
    }).catch(() => {});

    // Start Pub/Sub subscribers. Currently listens for connector-service's
    // `connector.credentials_stored` event and runs the auto-grant flow
    // that used to live synchronously in oauth-router.ts (deleted in
    // Phase 2a). See src/events/subscriber.ts for the full rationale.
    // Wrapped in try/catch so a Pub/Sub connectivity hiccup at boot
    // doesn't crash the HTTP server — the message loop reconnects on its
    // own once credentials/env are in place.
    try {
      startEventSubscribers();
    } catch (err) {
      log.error(
        { error: (err as Error).message },
        'Failed to start Pub/Sub subscribers at boot — continuing without auto-grant',
      );
    }

    // Cost attribution ingestion, the auto-reload sweep and the hourly
    // snapshot run inside the scheduled request
    // (POST /api/internal/jobs/cost-attribution-ingest), not on timers here:
    // under request-based CPU a timer only runs while some request happens to
    // be in flight, and the two-minute loop that used to live here was what
    // kept agent-service, governance and developer-proxy awake around the clock.

    // GCP Billing ingester — runs once daily at 02:00 UTC.
    // Queries BigQuery billing export for the prior day; no-op if BQ not configured.
    scheduleDailyCronAt(2, () => {
      runGcpBillingIngester().catch(err =>
        log.error({ error: (err as Error).message }, 'cost-attribution: gcp-billing-ingester failed'),
      );
    });

    // Anthropic Billing Reconciler — runs once daily at 03:00 UTC.
    // Compares internal cost_attribution_events totals against Anthropic's Billing API.
    scheduleDailyCronAt(3, () => {
      runAnthropicBillingReconciler().catch(err =>
        log.error({ error: (err as Error).message }, 'cost-attribution: anthropic-billing-reconcile failed'),
      );
    });

    // OpenAI Billing Reconciler — runs once daily at 03:30 UTC (staggered 30 min after Anthropic).
    // Compares internal cost_attribution_events totals against OpenAI's Usage API.
    scheduleDailyCronAt(3, () => {
      runOpenAIBillingReconciler().catch(err =>
        log.error({ error: (err as Error).message }, 'cost-attribution: openai-billing-reconcile failed'),
      );
    }, 30);

    const server = app.listen(PORT, () => {
      log.info({ event: 'server_start', port: PORT }, 'Control plane listening');
    });

    // Say out loud whether every approved model has a published rate.
    //
    // An unpriced model is not missing from the cost surfaces, it is WRONG on
    // them: computeRowCost falls back to a conservative default, so the request
    // succeeds, a usage row is written and a plausible number appears, billed at
    // some other model's price on every row until somebody compares a total
    // against a vendor invoice. The code-side ratchet cannot catch it, because a
    // model becomes reachable by a row in `models` and the unit suite has no
    // database. Boot is the first moment both halves exist together.
    //
    // Not awaited, and it never throws: this is a report, and a deployment with
    // an unpriced model is misbilled rather than broken.
    void reportPricingCoverageAtBoot(getPool());

    // Live dictation. Attached to the same server so it shares the port and the
    // graceful-shutdown path below.
    attachVoiceListenWebSocket(server);
    attachVoiceSpeakWebSocket(server);

    // Graceful shutdown.
    //
    // Cloud Run sends SIGTERM ~10s before SIGKILL. The previous handler called
    // server.close() without awaiting it and then immediately process.exit(0),
    // which severed in-flight requests mid-execution. That was particularly
    // dangerous for the Slack token rotation HTTP path: if SIGTERM arrived
    // between Slack consuming the old refresh token and the SM write
    // completing, the new token was lost and the chain broke until manually
    // reseeded.
    //
    // Now: stop accepting new connections, AWAIT in-flight requests to
    // complete (bounded by 8s — Cloud Run's grace is 10s, leaving 2s for
    // tracing flush and process teardown), then exit.
    //
    // Note: the slack rotation hot path has been moved to a Cloud Run Job
    // (slack-token-rotator-${env}), which is not subject to service SIGTERMs.
    // This handler still protects any other in-flight request that lands
    // during a deploy.
    let shuttingDown = false;
    process.on('SIGTERM', async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ event: 'server_shutdown' }, 'Received SIGTERM, draining in-flight requests');

      await new Promise<void>((resolve) => {
        let resolved = false;
        const settle = (reason: string) => {
          if (resolved) return;
          resolved = true;
          log.info({ event: 'server_shutdown_drained', reason }, 'Drain complete');
          resolve();
        };
        server.close(() => settle('server_close'));
        setTimeout(() => settle('drain_timeout'), 8000);
      });

      // Hand back any chat-turn lock this instance is still holding (ADR-041).
      // A lock left behind by a deploy makes the thread look busy until it
      // expires, and a message sent in the meantime is delivered into a turn
      // that is no longer running. Best-effort and non-fatal: shutdown proceeds
      // either way.
      await releaseAllLiveTurnLocks().catch((err) =>
        log.warn(
          { event: 'server_shutdown_lock_release_failed', error: (err as Error).message },
          'Could not release insights turn locks during shutdown',
        ),
      );
      await releaseAllLiveLiftoffTurnLocks().catch((err) =>
        log.warn(
          { event: 'server_shutdown_lock_release_failed', error: (err as Error).message },
          'Could not release Liftoff turn locks during shutdown',
        ),
      );

      await shutdownTracing();
      process.exit(0);
    });

    // A disorderly exit runs the same drain.
    //
    // The SIGTERM handler above describes the hazard: "A lock left behind by a
    // deploy makes the thread look busy until it expires, and a message sent in
    // the meantime is delivered into a turn that is no longer running." That
    // handler covers the ORDERLY exit only. Without an uncaughtException or
    // unhandledRejection handler, every disorderly exit still produces exactly
    // the state that handler exists to prevent — for example an `error` event
    // on a borrowed pg client with no listener, `exit(1)`, and a conversation
    // answered by nothing until the lease runs out.
    //
    // BOUNDED, and that is the whole design of it. A crash handler that hangs is
    // worse than the crash: the process stops serving, stops being replaced, and
    // holds its locks for the full lease instead of the 3 seconds it asked for.
    // So the lock release and the trace flush race a timer and the exit happens
    // either way.
    //
    // Not a recovery path. The process is going down; this only makes sure it
    // lets go of the threads it was holding on the way. The borrowed-client
    // guard is what stops the most common cause from reaching here at all, and
    // the 75-second heartbeat window is what bounds the damage when nothing runs
    // at all — a SIGKILL, an OOM kill.
    const FATAL_DRAIN_BUDGET_MS = 3000;
    let crashing = false;
    const fatal = (kind: 'uncaughtException' | 'unhandledRejection') => (err: unknown): void => {
      if (crashing) return;
      crashing = true;
      log.error(
        {
          event: 'fatal_exit',
          kind,
          error: (err as Error)?.message ?? String(err),
          stack: (err as Error)?.stack,
        },
        'Unhandled fault; releasing held chat-turn locks and exiting',
      );
      void (async () => {
        // ONE deadline for the whole handler, not one per step: two 3-second
        // bounds in sequence is a 6-second bound, and the number that matters is
        // how long the process can sit here holding locks it will never renew.
        const deadline = new Promise<void>((resolve) =>
          setTimeout(resolve, FATAL_DRAIN_BUDGET_MS).unref());
        const bounded = (work: Promise<unknown>): Promise<unknown> =>
          Promise.race([work.catch(() => undefined), deadline]);
        await bounded(Promise.all([
          releaseAllLiveTurnLocks(),
          releaseAllLiveLiftoffTurnLocks(),
        ]));
        await bounded(shutdownTracing());
        process.exit(1);
      })();
    };
    process.on('uncaughtException', fatal('uncaughtException'));
    process.on('unhandledRejection', fatal('unhandledRejection'));
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to start server');
    process.exit(1);
  }
}

function scheduleDailyCronAt(utcHour: number, fn: () => void, utcMinute = 0): void {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    utcHour, utcMinute, 0, 0,
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  const delayMs = next.getTime() - now.getTime();
  setTimeout(() => {
    fn();
    setInterval(fn, 24 * 60 * 60 * 1000);
  }, delayMs);
}

start();
