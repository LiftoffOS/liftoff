import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { createRequire } from 'module';

// R5 local rules plugin — mirrors the tenant-runtime pattern.
const require = createRequire(import.meta.url);
const r5LocalPlugin = {
  rules: {
    'no-stub-success-fallback': require('./eslint-rules/no-stub-success-fallback.js'),
    'attribution-agent-id-must-be-internal': require('./eslint-rules/attribution-agent-id-must-be-internal.js'),
    'no-raw-pool-on-rls-table': require('./eslint-rules/no-raw-pool-on-rls-table.js'),
    'no-turn-locks-outside-registry': require('./eslint-rules/no-turn-locks-outside-registry.js'),
    'no-unguarded-pool-construction': require('./eslint-rules/no-unguarded-pool-construction.js'),
  },
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', '*.js', '*.mjs', 'eslint-rules/'],
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      r5: r5LocalPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-namespace': 'off',
      'no-case-declarations': 'off',
      'no-useless-assignment': 'off',
      'prefer-const': 'warn',
      'preserve-caught-error': 'off',
      'r5/no-stub-success-fallback': 'error',
      // INV-PB-009 — agent-id columns here hold internal_agents.id. Guards the
      // consuming side of the id-space boundary; tenant-runtime's
      // r5/runtime-agent-id-must-be-resolved guards the producing side. Ships at
      // error: it tracks runtime-sourced provenance into the attribution write
      // chokepoints rather than blanket-matching, so it has no pre-existing
      // violations, and the bug it guards is silent by nature.
      'r5/attribution-agent-id-must-be-internal': 'error',
      // INV-PB-001 — the mechanical half of "never raw pool.query on an RLS
      // table". Until now that invariant's enforcement was the withAdminScope
      // import allow-list plus a drift check that read "grep src/ by hand",
      // which is how the tenant_members read in accounts/repository.ts reached
      // prod and 500'd on every call. Ships at error: matching is narrow (an
      // unscoped pool receiver AND a table on the generated RLS list), so the
      // only pre-existing violation is one backfill script that carries the
      // documented escape hatch.
      'r5/no-raw-pool-on-rls-table': 'error',
      // INV-PB-018 — a lock is not a heartbeat. The two turn-lock tables may
      // only be named in SQL by src/common/turn-registry.ts. Ships at error
      // with zero pre-existing violations, because the same change that adds
      // the rule moves the last three readers into that module: three
      // hand-written copies of `expires_at > NOW()`, two of them under a
      // comment asserting the opposite, which is how a dead container can wedge
      // a conversation until the lease runs out.
      'r5/no-turn-locks-outside-registry': 'error',
      // A pg Pool built outside the sanctioned constructors has no
      // borrowed-client guard, and pg-pool removes its own `error` listener the
      // moment a client is checked out — so one `Connection terminated
      // unexpectedly` on a borrowed client is an unhandled 'error' event and
      // Node exits the process: every such borrow site is a process-kill site.
      // Scoped to the request path; scripts and tests legitimately manage
      // their own.
      'r5/no-unguarded-pool-construction': 'error',
    },
  },
  // Phase 1 RLS: Restrict withAdminScope imports to approved modules only.
  // withAdminScope bypasses RLS — limit blast radius to admin, billing, and tenant service.
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/admin/**',
      // src/billing/** intentionally omitted: no billing source imports
      // withAdminScope in this PR's scope. Re-add when a billing module
      // actually needs the bypass (e.g., billing-controls-internal-router
      // when its cross-tenant read is refactored — see docs/rls-todo.md).
      'src/tenants/service.ts',
      // AccountService.cascadeDelete is admin-only (callable only via
      // DELETE /api/admin/accounts/:id) and needs withAdminScope to enumerate
      // and delete tenant data across the FK graph without per-tenant scope
      // gymnastics. Same precedent as tenants/service.ts.
      'src/accounts/service.ts',
      'src/agent-audit-logs/repository.ts',  // cross-tenant triggered_by name resolution
      // - composio-quota/repository.ts: Composio bills ONE organization-wide
      //   meter (20,000 calls/month, 100/min on free tier) across every tenant.
      //   Reading it is cross-tenant by definition — a per-tenant scope can
      //   only ever see the one number that does not answer the question. Two
      //   read-only aggregations: COUNT over cost_attribution_events (the same
      //   table and the same rationale as the cost-attribution ingesters) and
      //   COUNT over active tenants for the fair-share denominator. No tenant
      //   data leaves the module; the service returns one tenant's allocation.
      'src/composio-quota/repository.ts',
      // - source-migrations/repository.ts: ONE cross-tenant read, for the
      //   maintenance sweep that finishes imports whose conversion ran out of
      //   hourly distillation allowance (jobs/source-migration-resume-sweep.ts).
      //   "which workspaces have an import still waiting" cannot be asked from
      //   inside one tenant's scope. The query selects ids only — migration id,
      //   tenant id, importer — and every read and write that follows it goes
      //   back through withTenantScope for that one tenant. Same shape and same
      //   rationale as the invitation sweeps in tenant-members/repository.ts.
      'src/source-migrations/repository.ts',
      'src/infrastructure/database.ts',
      // Pre-tenant-context lookups: these auth/setup paths resolve which
      // tenant a request belongs to BEFORE any tenant context exists. The
      // token-lookup must read mcp_tokens / setup_tokens to determine which
      // tenant a request is for — there is no app.current_tenant_id yet to
      // scope against. withAdminScope (BYPASSRLS) is the correct primitive.
      // Each callsite is restricted to a single SELECT-by-token-hash + an
      // optional UPDATE last_used_at; no cross-tenant data is exposed.
      'src/mcp-server/mcp-auth.ts',           // Bearer-token auth middleware
      // - referrals/repository.ts: the referral programme's pre-tenant-context
      //   half. A share code is resolved at ACCOUNT creation, when the person
      //   signing up has no workspace at all and the code itself is what
      //   identifies the referring tenant — the same auth-lookup shape as the
      //   token lookups above. The attribution row is then written, and later
      //   pointed at the workspace that account provisions, before any tenant
      //   scope for either side exists. liftoff-billing's questions ("was this
      //   paying workspace referred") arrive keyed by the REFERRED tenant while
      //   the row is scoped to the REFERRER, so they cannot be answered under
      //   either scope. Every admin-scoped statement in the file is keyed by
      //   code, account id, tenant id or referral id; the page's own reads and
      //   writes all run under withTenantScope.
      'src/referrals/repository.ts',
      // MCP OAuth front door (plan v6.1): the AS endpoints and the access-
      // token verifier all run pre-tenant-context — the token/code/refresh
      // row IS what identifies the tenant, so there is no tenant id to scope
      // with until after the lookup. withAdminScope wraps each operation in
      // one atomic transaction (redemption/rotation single-tx requirement).
      'src/oauth/verifier.ts',
      'src/oauth/authorization-server-router.ts',
      'src/claude-code-proxy/service.ts',     // setup_token exchange (PKCE flow)
      'src/claude-code-proxy/router.ts',      // self-revocation by liftoff_mcp_* token
      // Chat share links: findShareById resolves /share/<id> deep links
      // BEFORE any tenant context exists — the share row IS what identifies
      // the tenant. Single SELECT-by-PK; the router enforces membership on
      // the row's tenant and the write path runs under withTenantScope.
      // Same precedent as tenant-members/repository.ts findInvitationById.
      'src/chat-shares/repository.ts',
      // Cross-tenant / pre-tenant-context paths added in the PR1 RLS hardening:
      // - knowledge/repository.ts: webhook callbacks arrive from external
      //   providers (Google Drive, MS Graph, Box) keyed only by channel
      //   token / subscription id — admin scope resolves the tenant from
      //   the row, after which the webhook router runs subsequent calls
      //   under withTenantScope. Also: cross-tenant pending-extraction
      //   scan + webhook renewal scan.
      'src/knowledge/repository.ts',
      // - maintenance/expire-agent-messages.ts: scheduled cross-tenant
      //   sweeps (agent_messages expiry, slack_event_dedup TTL cleanup,
      //   active-tenant list for expire-connector-content).
      'src/maintenance/expire-agent-messages.ts',
      // - maintenance/purge-soft-deleted.ts: the retention purge. "Which rows
      //   anywhere are past their grace period" is cross-tenant by
      //   definition - a per-tenant scope can only ever sweep the tenant it
      //   is scoped to, and the tenants needing a sweep are exactly the ones
      //   nobody is making a request for. Deletes only by deleted_at, never
      //   by tenant, and hands accounts to AccountService.cascadeDelete
      //   rather than reaching into their rows.
      'src/maintenance/purge-soft-deleted.ts',
      // - llm/vision.ts: reads the GLOBAL model catalog (`models` has no
      //   tenant_id at all) to answer "can this model see a picture". One
      //   SELECT of model_id, cached, no tenant data anywhere near it.
      'src/llm/vision.ts',
      // - media/inbound.ts: the retention sweep for chat media a person
      //   uploaded and never sent. Cross-tenant by nature — it is one
      //   housekeeping pass over the estate, not a tenant's own request, and a
      //   per-tenant scope could only find abandoned uploads for tenants
      //   somebody happened to enumerate. Two statements, both narrow: a SELECT
      //   of unclaimed rows past the window and a DELETE by primary key. The
      //   module's other exports (store, claim) are tenant-scoped.
      'src/media/inbound.ts',
      // - generated-files/sweep-staged.ts: the retention sweep for files a
      //   producer STAGED and nobody ever presented. Cross-tenant for the same
      //   reason as the sweep above and no other: it is one housekeeping pass
      //   over the estate, and a per-tenant scope could only reach tenants
      //   somebody happened to enumerate. Two statements, both narrow: a SELECT
      //   of rows past their own lifetime and a DELETE by primary key that
      //   repeats the lifetime predicate, so a file presented in between is
      //   left alone. It never sees a person's upload — that is the other
      //   sweep's predicate — and the module exports nothing else.
      'src/generated-files/sweep-staged.ts',
      // - data-management/repository.ts: SOC 2 / GDPR compliance tooling.
      //   export_jobs and deletion_requests are FORCE RLS (migration 339), and
      //   the pending-export sweep, scheduled-deletion sweep and
      //   verification-token lookup all run before any tenant is known — the
      //   row is what identifies the tenant. Operator-only entry points.
      'src/data-management/repository.ts',
      // - scripts/backfill-skill-metrics.ts: cross-tenant agent enumeration
      //   for one-shot backfill. Per-agent writes use withTenantScope.
      'src/scripts/backfill-skill-metrics.ts',
      // - scripts/backfill-template-memory-scope.ts: cross-tenant enumeration
      //   of template hires whose scope no request ever set, plus the count
      //   of rows changed afterwards. Per-agent writes go through
      //   InternalAgentService.update, under tenant scope. Same class as
      //   backfill-skill-metrics.
      'src/scripts/backfill-template-memory-scope.ts',
      // - scripts/backfill-loop-over-steps-root.ts: cross-tenant enumeration of
      //   stored workflow steps whose `loop.over` addresses
      //   `output.<stepId>.<field>` — a path that resolves to nothing, so the
      //   loop iterates zero times — plus the count of values still carrying
      //   it afterwards. The defect is fleet-wide and the rows carrying it are
      //   not known in advance, so no tenant scope can frame the read.
      //   Per-agent writes go through InternalAgentService.update, under
      //   tenant scope. Same class as backfill-template-memory-scope.
      'src/scripts/backfill-loop-over-steps-root.ts',
      // - scripts/embed-sweep-chat-turns.ts: cross-tenant enumeration of
      //   un-embedded / provider-drifted chat turns (semantic recall v2
      //   sweep). Read-only id sweep; per-turn writes run under
      //   withTenantScope inside embedTurn. Same class as
      //   backfill-skill-metrics.
      'src/scripts/embed-sweep-chat-turns.ts',
      // - scripts/backfill-platform-assistant-turns.ts: cross-tenant
      //   enumeration of Liftoff / Insights Manager threads whose messages
      //   predate migration 547 and so carry no turn. A history repair is
      //   inherently every-tenant: there is no one tenant to scope it to, and
      //   scoping per tenant would need a caller who already knows the list.
      //   The admin reach is the thread-id read ONLY; every turn insert and
      //   message stamp runs under that thread's own withTenantScope, in one
      //   transaction per thread. Same class as embed-sweep-chat-turns.
      'src/scripts/backfill-platform-assistant-turns.ts',
      // - scripts/calibrate-skill-dedup-thresholds.ts: cross-tenant skill
      //   read for one-shot threshold calibration. Read-only — never writes
      //   to internal_agents.
      'src/scripts/calibrate-skill-dedup-thresholds.ts',
      // - scripts/restamp-workspace-ai-policies.ts: operator re-stamp of
      //   Workspace AI routing policies. Cross-tenant READ of tenant ids +
      //   selectedVendor markers only; per-tenant writes go through
      //   ModelRegistryService.setWorkspaceVendor, whose repository runs
      //   under withTenantScope. Same class as backfill-skill-metrics.
      'src/scripts/restamp-workspace-ai-policies.ts',
      // - scripts/backfill-runtime-agent-skills.ts: cross-tenant
      //   enumeration of active internal_agents with skills, to re-emit
      //   skills_updated events so tenant-runtime backfills its agent_skills
      //   table. Read-only on internal_agents; publishes via the outbox.
      'src/scripts/backfill-runtime-agent-skills.ts',
      // Re-attributes chat-surface voice transcriptions that were billed with no
      // agent id and so fell through to platform overhead. It must read across
      // every tenant to find them and pair each with the spoken reply that
      // carries the agent, then write both the ledger row and the OUs the row
      // never charged — none of which is scoped to one tenant.
      'src/scripts/backfill-chat-voice-attribution.ts',
      // - scripts/backfill-skill-provenance.ts: one-time P1.0 sync of
      //   internal_agents.skills from the tenant-runtime live set, stamping
      //   provenance so a redistill stops discarding learned skills. Needs a
      //   cross-tenant enumeration of every agent to pick its work set; every
      //   per-agent read and write is then tenant-scoped (withTenantScope).
      'src/scripts/backfill-skill-provenance.ts',
      // - scripts/backfill-skill-ids.ts: one-time assignment of a stable id to
      //   every stored skill that lacks one, adopting the id the runtime already
      //   uses so the next publish reactivates that row rather than replacing
      //   it. Needs a cross-tenant enumeration to pick its work set; every
      //   per-agent read and write is then tenant-scoped (withTenantScope).
      //   Same class as backfill-skill-provenance.
      'src/scripts/backfill-skill-ids.ts',
      // - scripts/backfill-capability-embeddings.ts: cross-tenant enumeration
      //   of agents whose capability embedding is NULL, which is all of them —
      //   the writer read a column that never existed, so no vector was ever
      //   stored. Read-only id sweep; every write runs under withTenantScope
      //   inside generateAndStoreEmbedding. Same class as embed-sweep-chat-turns.
      'src/scripts/backfill-capability-embeddings.ts',
      // - scripts/converge-runtime-skill-provenance.ts: re-publishes the
      //   authoritative skill provenance fleet-wide so the runtime's own
      //   columns stop disagreeing with it. Needs a cross-tenant read of
      //   internal_agents.skills to pick its work set; the publish itself goes
      //   through publishEvent, which enqueues under its own admin scope.
      //   Same class as backfill-skill-provenance.
      'src/scripts/converge-runtime-skill-provenance.ts',
      // - scripts/audit-registered-url-safety.ts: READ-ONLY E1 sweep that names
      //   every already-registered custom MCP server / external agent whose
      //   endpoint the SSRF guard would now reject. Needs a cross-tenant read
      //   because the point is to report the whole estate before enforcement.
      'src/scripts/audit-registered-url-safety.ts',
      // - scripts/audit-agent-schedulers.ts: hourly Layer B audit job
      //   reads `tenants` + `internal_agents` across every tenant to build
      //   per-tenant expected-cron-agent counts. No writes; cross-tenant
      //   read is the whole point of an independent auditor.
      'src/scripts/audit-agent-schedulers.ts',
      // - scripts/converge-agent-execution-allowed.ts: repairs tenants whose
      //   entitlement still refuses execution after their account's billing was
      //   provisioned. The candidate LIST spans tenants by definition, so it
      //   has no single scope to run under; every write goes back through
      //   EntitlementService, which opens its own tenant scope per tenant.
      'src/scripts/converge-agent-execution-allowed.ts',
      // - scripts/apify-cost-trueup.ts: reconciles the platform Apify account's
      //   run list against the ledger. The account is one account for every
      //   tenant, so the runs are attributed to tenants by reading the usage
      //   evidence and the ledger ACROSS tenants; every write goes back through
      //   ingestEventWithBuckets, the one consumption boundary, which opens its
      //   own admin scope per event exactly as the executor's booking does.
      'src/scripts/apify-cost-trueup.ts',
      // - generated-files/router.ts: Cloud Tasks callback: tenant_id
      //   resolved server-side via SELECT generated_files BY id before
      //   tenant scope is used for writes. Admin scope is restricted to
      //   the single tenant-id lookup; all writes run under withTenantScope.
      'src/generated-files/router.ts',
      // - jobs/sync-dropbox-folders.ts: cross-tenant Dropbox sweep over
      //   root folders; admin scope intentional. Per-folder writes are
      //   performed via the knowledge repository (withTenantScope).
      'src/jobs/sync-dropbox-folders.ts',
      // - knowledge/embedding-service.ts: the embedding worker (Cloud
      //   Scheduler) sweeps knowledge_items across all tenants for rows
      //   needing embeddings. Admin scope is restricted to the single
      //   SELECT for the pending list; per-row writes happen via
      //   withTenantScope. Same pattern as sync-dropbox-folders.ts.
      'src/knowledge/embedding-service.ts',
      // - agent-chat/slack-adapter/webhook-router.ts: Slack delivers
      //   webhooks identified only by api_app_id; there is no tenant
      //   context until we resolve agent_slack_apps. Admin scope is
      //   restricted to the single tenant-id lookup; all subsequent
      //   reads (internal_agents, agent_slack_installs) run under
      //   withTenantScope.
      'src/agent-chat/slack-adapter/webhook-router.ts',
      // - agent-chat/teams-adapter/repository.ts: inbound Bot Framework
      //   Activities carry only the Azure AD tenant id (channelData.tenant.id),
      //   not a Liftoff tenant. findTenantByAadTenant resolves it under admin
      //   scope (the single teams_tenant_installs lookup); every other query in
      //   the file runs under withTenantScope.
      'src/agent-chat/teams-adapter/repository.ts',
      // - agent-chat/slack-adapter/workspace-repository.ts: inbound workspace-app
      //   Slack events carry only team_id; findWorkspaceInstallByTeam resolves
      //   the tenant under admin scope (the single slack_workspace_installs
      //   lookup, mirroring teams-adapter/repository.ts). Every other query in
      //   the file runs under withTenantScope.
      'src/agent-chat/slack-adapter/workspace-repository.ts',
      // - agent-chat/slack-adapter/identity-resolver.ts: account_slack_identities
      //   cache table has no tenant_id column (Liftoff account → Slack user
      //   workspace mapping is tenant-agnostic). All access is via withAdminScope.
      'src/agent-chat/slack-adapter/identity-resolver.ts',
      // - agent-chat/slack-adapter/interactivity-router.ts: Slack interactivity
      //   POSTs identified by api_app_id; pre-tenant-context lookup of
      //   agent_slack_apps to resolve tenant_id. Same auth-lookup pattern as
      //   webhook-router.ts. All subsequent reads run under withTenantScope.
      'src/agent-chat/slack-adapter/interactivity-router.ts',
      // - internal-agent-oversight/service-internal.ts: reverse Slack-user
      //   cross-check against the account_slack_identities cache, used to
      //   authenticate the Slack actor before approving/rejecting on their
      //   behalf. The cache table has no tenant_id column (see above).
      'src/internal-agent-oversight/service-internal.ts',
      // - scripts/backfill-slack-interactivity-url.ts: one-off backfill
      //   script that enumerates active agent_slack_apps cross-tenant and
      //   pushes apps.manifest.update for each. Same precedent as
      //   backfill-skill-metrics.ts.
      'src/scripts/backfill-slack-interactivity-url.ts',
      // - event-sources/service.ts: adminLookupByToken is the pre-tenant-
      //   context lookup for POST /api/events/custom/:token. The URL token
      //   uniquely identifies one event_sources row; we read tenant_id +
      //   signing secret out of it under admin scope, then switch into
      //   withTenantScope for everything else (rate-limit/dedupe/dispatch).
      //   Same auth-lookup primitive pattern as the Slack webhook router.
      //   purgeDeliveriesBySha256 is also admin-scope: DSAR / right-to-
      //   erasure deletes intentionally cross tenants by hash lookup.
      'src/event-sources/service.ts',
      // - event-sources/inbound-router.ts: per-rule outbox enqueue runs
      //   under withAdminScope because control_plane_outbox is a
      //   platform-level table (no app.current_tenant_id GUC). The
      //   enqueue is parameterized by tenantId so the outbox row is
      //   naturally tenant-scoped; admin scope is just the auth
      //   primitive for INSERTs into the cross-tenant outbox table.
      //   Same pattern as events/publisher.ts.
      'src/event-sources/inbound-router.ts',
      // - tenant-members/repository.ts: findMembership is an auth-lookup
      //   primitive called BEFORE tenant context is established. RLS on
      //   tenant_members (migration 095) would deny the lookup; admin
      //   scope is correct. Query is naturally scoped by (tenant_id,
      //   account_id) so admin bypass exposes no cross-tenant data.
      'src/tenant-members/repository.ts',
      // - insights/chat-repository.ts: getCallerRole is the same auth-lookup
      //   pattern (called from insights/router.ts + stream-router.ts before
      //   tenant scope is established). Query is naturally scoped by
      //   (tenant_id, account_id).
      'src/insights/chat-repository.ts',
      // - liftoff/chat-repository.ts: the same two uses as its insights
      //   counterpart. getCallerRole is the pre-tenant-context auth lookup
      //   (naturally scoped by (tenant_id, account_id)), and touchThread is an
      //   internal by-id updated_at bump reached only after the caller has
      //   already been visibility-checked through getThread.
      'src/liftoff/chat-repository.ts',
      // - billing/billing-proxy.ts: tenant-membership guard runs BEFORE
      //   forwarding the request body to liftoff-billing. Same auth-lookup
      //   pattern as findMembership / getCallerRole — pre-tenant-context,
      //   query naturally scoped by (tenant_id, firebase_uid).
      'src/billing/billing-proxy.ts',
      // - billing/provisioning-outbox-worker.ts: background worker
      //   processes the provisioning_outbox queue without per-request
      //   tenant context. claim/finalize queries are naturally bound by
      //   tenant_id from the outbox row; admin scope is correct.
      'src/billing/provisioning-outbox-worker.ts',
      // - billing/billing-controls-internal-router.ts: backfillUnmeteredSpendEvents
      //   is an internal billing-init endpoint keyed by accountId. Reads
      //   billing_spend_events across every tenant under the account to
      //   backfill Stripe meter events — cross-tenant by design.
      'src/billing/billing-controls-internal-router.ts',
      // - billing/billing-suspension-publisher.ts: a billing suspension is
      //   account-keyed and reaches every tenant under the account; the
      //   tenant LIST is read under admin scope, bounded to that account, and
      //   each snapshot is then republished in its own tenant scope through
      //   the entitlement service.
      'src/billing/billing-suspension-publisher.ts',
      // - billing/auto-reload-sweep.ts: finds pre-pay accounts stopped under
      //   their auto-reload threshold across every account (billing_controls
      //   is account-keyed, no tenant to scope to) and stamps each claim, as
      //   the drain does from the cross-tenant ingester.
      'src/billing/auto-reload-sweep.ts',
      // - operator-dashboard/service.ts: cross-tenant operator aggregation
      //   reading alerts. Query is bound by tenant_id = $1 (the operator
      //   chose which tenant to inspect); admin scope is needed because
      //   the dashboard does NOT establish request-level tenant context.
      'src/operator-dashboard/service.ts',
      // - cost-attribution/repository.ts: insertEvents is a cross-tenant
      //   batch insert (ingester polls multiple tenants in one run);
      //   wrapping per-event in withTenantScope would lose batch
      //   performance. Tenant-scoped read methods (getCostBreakdown,
      //   getCostByAgent) use withTenantScope.
      'src/cost-attribution/repository.ts',
      // - cost-attribution/ingestion/*.ts: batch ingesters + nightly
      //   reconcilers operate across every tenant by design.
      'src/cost-attribution/ingestion/anthropic-billing-reconciler.ts',
      'src/cost-attribution/ingestion/openai-billing-reconciler.ts',
      'src/cost-attribution/ingestion/backfill-correlator.ts',
      // - platform-llm-ingester.ts: sweeps llm_usage_log across every tenant to
      //   ingest platform LLM usage into cost_attribution_events. Cross-tenant
      //   read by design; per-row writes go through ingestEventWithBuckets
      //   (which self-scopes via withAdminScope). Was a documented out-of-PR1
      //   raw-pool caller in docs/rls-todo.md — now closed.
      'src/cost-attribution/ingestion/platform-llm-ingester.ts',
      // - prompt-registry/repository.ts: OPERATOR surface. /api/prompt-registry is
      //   mounted behind Firebase auth + access-gate only; the by-PK write/rollout
      //   endpoints and list-all reads carry no tenant context (router.ts +
      //   service.ts signatures), so they run under withAdminScope. The
      //   tenantId-bearing read/create paths use withTenantScope. RLS-force census.
      'src/prompt-registry/repository.ts',
      // - corrections/repository.ts: per-tenant repo, but cleanupOldRateUsage is a
      //   cross-tenant cron (deletes correction_rate_usage older than 2 days with
      //   no tenant filter) → withAdminScope. All other methods use withTenantScope
      //   or set_config-in-own-tx. RLS-force census.
      'src/corrections/repository.ts',
      // - RLS-force census, operator/by-PK surfaces + background jobs. Each uses
      //   withAdminScope only for by-PK / list-all / no-tenant-context ops;
      //   tenantId-bearing methods use withTenantScope.
      'src/model-registry/repository.ts',   // model_rollouts by-PK approval workflow
      'src/deployments/repository.ts',      // deployment by-PK approve/deploy/rollback + list-all
      'src/overage-rules/repository.ts',    // billing operator by-PK ops + by-plan cross-tenant read
      'src/hitl-late-feedback/repository.ts', // background sync job (getUnsynced/markSynced) + by-PK findById
      // - RLS-force census, ROUTER class:
      'src/internal-api/harvest-router.ts',   // resolve tenant_id FROM connectors by id (pre-tenant-context service lookup)
      'src/internal-agents/router.ts',        // fetch is_system (platform) agent config by id (no tenant context)
      // - RLS-force census, CROSS_TENANT_JOB class: background jobs / scripts /
      //   reconcilers that operate across every tenant (or by-id with no request
      //   tenant context) by design.
      'src/external-agents/health-check-service.ts',
      'src/external-agents/credential-refresh-service.ts',
      'src/jobs/backfill-pinned-knowledge.ts',
      'src/rollout/health-monitor-job.ts',
      'src/scripts/backfill-agent-instructions-md.ts',
      'src/scripts/cleanup-test-accounts.ts',
      'src/scripts/quarantine-invalid-integrations.ts',
      'src/scripts/redistill-cron-agents.ts',
      'src/scripts/redistill-work-inbox-agents.ts',
      'src/web-tools/vendor-reconciliation.ts',
      'src/cost-attribution/ingestion/backfill-runner.ts',
      // - billing/x402-wallet-service.ts: READ-ONLY cross-tenant SUM over
      //   cost_attribution_events (cost_bucket='x402_wallet_funded'), compared
      //   against the x402 wallet's on-chain outbound USDC. The wallet is one
      //   platform treasury spanning every tenant, so no tenant scope can
      //   frame the query — the same reason vendor-reconciliation.ts is here.
      'src/billing/x402-wallet-service.ts',
      // - scripts/report-tiered-pricing-gap.ts: READ-ONLY cross-tenant scan of
      //   cost_attribution_events, quantifying how much the pre-migration-379
      //   flat-rate pricing under-attributed on models with conditional rate
      //   bands. "How much did we mis-bill across the estate" is a cross-tenant
      //   question by definition — a per-tenant scope can only ever answer it
      //   one tenant at a time, and the answer has to be summed to be useful.
      //   Same table and same rationale as the ingesters above. The script
      //   issues no INSERT/UPDATE/DELETE anywhere; deciding what to do with the
      //   number is deliberately a human step outside it.
      'src/scripts/report-tiered-pricing-gap.ts',
      'src/disaster-recovery/restore-drill.ts',
      // - RLS-force census, SERVICE class: content-table writers (llm_usage_log may
      //   carry NULL tenant_id for platform calls), cross-account aggregations, and
      //   operator by-id rollout ops.
      'src/llm/usage-tracker.ts',              // llm_usage_log writer (tenant_id may be NULL) + by-session attribution
      'src/embedding/init.ts',                 // llm_usage_log embed-usage writer (tenant_id may be NULL)
      'src/web-tools/vendor-spend-monitor.ts', // cross-tenant vendor MTD/hourly spend aggregation
      'src/billing/addon-service.ts',          // entitlements read across all tenants of an account
      'src/billing/subscription-items-service.ts', // count agents across all tenants of an account
      'src/rollout/orchestration-service.ts',  // by-id getCurrentStep + cross-tenant scheduled-advancement scan
      // - RLS-force census, OWN_TX/INFRA class:
      'src/infrastructure/audit-context.ts',   // pre-tenant-context auth lookups on tenant_members
      // - cost-attribution/snapshot-service.ts: cross-tenant rollup, then
      //   per-tenant upsert via repository.upsertSnapshot (tenant-scoped).
      'src/cost-attribution/snapshot-service.ts',
      // - workflow-engine/*: background Cloud Tasks callbacks invoked by the
      //   tenant runtime. The callback payload carries runId, which uniquely
      //   identifies the tenant via the workflow_runs row — no request-level
      //   tenant context. Admin scope is the auth-lookup primitive here;
      //   queries are bound by run_id / step id.
      'src/workflow-engine/step-executor.ts',
      'src/workflow-engine/state-recovery.ts',
      'src/workflow-engine/router.ts',
      // - internal-agents/outbox.ts + events/outbox.ts: outbox infrastructure
      //   (plan §5.2). Worker claims/marks rows across every tenant by design;
      //   inline-publish from request handlers is naturally tenant-scoped via
      //   the row's tenant_id column. Mirror provisioning-outbox-worker.ts.
      'src/internal-agents/outbox.ts',
      'src/events/outbox.ts',
      'src/events/publisher.ts',
      // - knowledge/outbox.ts: knowledge ingestion event-driven pipeline (plan
      //   §2). Mirror of internal-agents/outbox.ts — worker claims/marks rows
      //   across every tenant by design; inline-publish from request handlers
      //   is naturally tenant-scoped via the row's tenant_id column.
      'src/knowledge/outbox.ts',
      // - hitl-late-feedback/trust-outbox.ts: durable outbox that delivers
      //   late-feedback trust decisions to the governance engine. Mirror of
      //   internal-agents/outbox.ts — the worker claims/marks rows across every
      //   tenant (FOR UPDATE SKIP LOCKED + reaper); inline enqueue runs in the
      //   caller's tenant-scoped transaction and self-scopes via the row's
      //   tenant_id column. Delivery is a service-to-service POST, not a query.
      'src/hitl-late-feedback/trust-outbox.ts',
      // - internal-agents/events.ts: legacy convenience that opens its own
      //   withAdminScope tx to enqueue an outbox row. The tx is naturally
      //   scoped to (tenant_id, internal_agent_id, event_type) from the
      //   caller's payload.
      'src/internal-agents/events.ts',
      // - internal-agents/reconciler.ts: cross-tenant scan to detect drift
      //   between PB.internal_agents and runtime mapping state. Each tenant
      //   sub-scan reads from the runtime via OIDC fetch and republishes via
      //   the outbox. Admin scope is the auth-lookup primitive.
      'src/internal-agents/reconciler.ts',
      // - team-provisioning/swe-autoprovision.ts: reconciler that scans active
      //   version-control connectors across EVERY tenant to auto-provision the
      //   software-delivery-team on connection. The cross-tenant scan is the admin
      //   op; each provision then self-scopes via TeamProvisioningService.
      'src/team-provisioning/swe-autoprovision.ts',
      // - scripts/outbox-acknowledgment-reconciler.ts: cross-tenant Cloud Run
      //   Job that polls the runtime for every completed outbox row, marks
      //   the row, and republishes when needed. Reads from both outbox tables
      //   across every tenant by design (mirrors reconciler.ts).
      'src/scripts/outbox-acknowledgment-reconciler.ts',
      // - scripts/validate-tenant-runtime-urls.ts: cross-tenant Cloud Run Job
      //   that lists every active tenant and verifies its runtime_url matches
      //   the live Cloud Run agent-service URL. Read-only; admin scope is the
      //   tenant-enumeration primitive.
      'src/scripts/validate-tenant-runtime-urls.ts',
      // - notifications/repository.ts: per-account notification queue table.
      //   Digest aggregation reads/writes across many tenants (one account
      //   can belong to multiple workspaces); the digest job has no
      //   per-request tenant scope. Inserts/updates carry account_id + (when
      //   present) tenant_id so a row is always naturally scoped, but admin
      //   bypass is required for the queue to be operated from a single
      //   service-wide context.
      'src/notifications/repository.ts',
      // - push/repository.ts: browser push subscriptions are account-scoped,
      //   not tenant-scoped, and carry no RLS for the same reason
      //   notifications does: a person's devices follow them across every
      //   workspace they belong to, so binding a token to a tenant would
      //   silence them the moment they switched. Every query here is keyed on
      //   account_id or on the globally unique fcm_token, and the send path
      //   runs from a digest tick or a service callback with no tenant in
      //   context to scope with.
      'src/push/repository.ts',
      // - notification-links/repository.ts: findLinkById is a pre-tenant-context
      //   lookup by primary key. The link row IS what identifies the tenant, so
      //   there is no tenant id to scope with until after the read; the router
      //   then enforces live membership on that row's tenant before returning
      //   anything, and answers the same 404 for unknown id and non-member.
      //   Exactly the precedent chat-shares/repository.ts set for findShareById.
      'src/notification-links/repository.ts',
      // - notifications/digest.ts: hourly Cloud-Scheduler tick scans every
      //   non-deleted account, fires emails for those whose local clock
      //   struck DIGEST_HOUR. Cross-tenant by design (operating on accounts,
      //   not within a tenant). Tenant_members join is filtered by the
      //   account_id from the candidate set.
      'src/notifications/digest.ts',
      // - RLS-force census GAP FIX: allow-listed files had their
      //   cross-tenant withAdminScope calls wrapped by PR1 but their main raw
      //   pool.query callsites were left unwrapped; these two files were missed
      //   entirely. Now fully wrapped — withAdminScope only for list-all /
      //   by-PK / no-tenant-context ops; tenantId-bearing methods use
      //   withTenantScope.
      // - entitlements/repository.ts: findAll is an operator list-all across
      //   tenants (no tenant filter) → withAdminScope; every other method uses
      //   withTenantScope (findByTenantId, create, update, snapshots).
      'src/entitlements/repository.ts',
      // - tenant-promotion/service.ts: operator tooling that promotes a tenant
      //   between DB tiers outside any tenant request scope; every RLS-table
      //   op (promotion_snapshots, migrated_tenant_data, tenant_promotions,
      //   the exportTenantData sweep over connectors/workflow_tasks) →
      //   withAdminScope.
      'src/tenant-promotion/service.ts',
      // - RLS-force census GAP FIX round 2 (dynamic-table class): these name the
      //   table at runtime (FROM ${tableName}), which a literal-table census
      //   cannot see. retention-service.getRetentionStats does a cross-tenant
      //   record-count over a table map that includes audit_log (RLS) with no
      //   tenant filter → withAdminScope. (export-service / deletion-service /
      //   chat-rate-limiter are per-tenant → withTenantScope, no allow-list.)
      'src/data-management/retention-service.ts',
      // - diagnostics-fleet/internal-router.ts: /api/internal/diagnostics/fleet-tenants
      //   lists every active, execution-allowed tenant (with a runtime_url) so the
      //   tenant-runtime diagnostics harvester auto-discovers the fleet instead of a
      //   hand-maintained CSV. A cross-tenant enumeration by design (SELECT ... FROM
      //   tenants JOIN entitlements, no tenant filter) with no per-request tenant
      //   scope; mirrors reconciler.listTenants / validate-tenant-runtime-urls. Read-
      //   only and service-auth gated (TENANT_RUNTIME_SERVICE_TOKEN). Admin scope is
      //   the tenant-enumeration primitive.
      'src/diagnostics-fleet/internal-router.ts',
      // - billing/ou-meter-reconciliation-service.ts: the daily ledger-vs-Stripe
      //   comparison aggregates billing_spend_events and cost_attribution_events
      //   (both FORCE RLS) across EVERY tenant, grouped by account, with no
      //   tenant filter — there is no per-request tenant scope for a scheduler
      //   job, and a per-tenant loop would defeat the point: the defect it
      //   exists to catch (days of missing rows) is only visible in the
      //   aggregate. Read-only on both RLS tables; the
      //   only write is the upsert to ou_meter_reconciliation, which is not RLS.
      //   Service-auth gated.
      'src/billing/ou-meter-reconciliation-service.ts',
      // - scripts/distill-ab-harness.ts: reads distill_runs (FORCE RLS) back
      //   across the whole A/B window to aggregate per-branch latency, retry and
      //   cost. The aggregate IS the experiment's result, and the acceptance
      //   gates are read from that table, so recomputing it per tenant would
      //   both defeat the purpose and risk disagreeing with the gates. Read-only
      //   on the RLS table; dev-only (it refuses to run when ENVIRONMENT=prod).
      'src/scripts/distill-ab-harness.ts',
      // - scripts/distill-ab-corpus.ts: `--from-agents` enumerates internal_agents
      //   across tenants to build the replay corpus from real distill inputs.
      //   A cross-tenant read by design — a corpus drawn from one tenant would
      //   not be the distribution the comparison is meant to cover. Read-only,
      //   dev-only, and not on any request path.
      'src/scripts/distill-ab-corpus.ts',
      // - scripts/distill-shadow-judge.ts: sweeps distill_shadow_comparisons
      //   (FORCE RLS) across tenants to judge and tally shadow pairs. The
      //   verdict DISTRIBUTION is the result, so a per-tenant loop would defeat
      //   the purpose at these volumes. Reads the two stored artifacts and
      //   stamps the verdict back on the same row; no other table is touched.
      'src/scripts/distill-shadow-judge.ts',
      'src/test-utils/**',
      'src/**/*.test.ts',
      'src/**/*.integration.test.ts',
    ],
    rules: {
      // Use `patterns` (glob-based) rather than `paths` (exact-string-based)
      // so deeper relative imports like `'../../../infrastructure/database'`
      // also fire the rule. Plain `paths` matched only two literal strings
      // and was bypassable by any file 3+ levels deep.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/infrastructure/database'],
          importNames: ['withAdminScope'],
          message: 'withAdminScope bypasses RLS. Allowed callers are listed in the `ignores` block of eslint.config.mjs. To authorize a new caller, append it there with a comment explaining why bypassing tenant scope is correct for that path.',
        }],
      }],
    },
  }
);
