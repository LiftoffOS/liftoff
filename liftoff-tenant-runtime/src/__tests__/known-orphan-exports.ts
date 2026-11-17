// Exports that nothing reaches, as of the day the reachability gate landed.
//
// This is a DEBT LIST, not a permission list. Every line is a symbol that no
// production code names — some are genuinely dead, some are reached in a way
// the checker cannot see (a name built as a string, a barrel re-export a
// consumer resolves at runtime). Both kinds should shrink.
//
// The gate exists to stop the list GROWING. Adding a line to it is allowed, and
// should be rare enough that a reviewer asks why. The three answers that do not
// need a line here:
//
//   * wire it — the usual answer, and the reason the gate exists
//   * delete it — a feature nothing calls is not a feature
//   * rename it with a leading underscore, if it genuinely exists for tests
//
// Regenerate deliberately, never casually: a bulk refresh silently absorbs the
// exact defect this was built to catch.
//
// ── Written-but-unread, registered on purpose ─────────────────────────────────
//
// The gate below sees exported VALUES. It cannot see a field inside a JSONB
// document, so anything of that shape has to be declared here in prose or it is
// invisible until somebody finds it years later and cannot tell whether it was
// deliberate. `internal_agents.delegates` survived to migration 335 exactly that
// way.
//
//   AgentRunItem.parentId  (src/agent-execution/run-state/types.ts)
//     Written by AgentRunStateService.appendItem on every run item; read by
//     nothing today. Named consumer: rerun-from-step-N, which needs to know
//     which item each item followed in order to replay a prefix. HITL what-if
//     branching and chat message-edit are the other two. The linkage cannot be
//     reconstructed after the fact from a flat array, which is why it is
//     captured before the first consumer exists rather than after.
//     Delete it if none of those three is built.

export const KNOWN_ORPHAN_EXPORTS: readonly string[] = [
  // Landed on main after this baseline was taken, so it is pre-existing debt
  // rather than something the gate let through. Exported alongside the two
  // resolvers beside it, which both handle the unknown-provider case
  // internally — wiring it artificially would be worse than listing it.
  'src/llm/tiers.ts::isKnownTierProvider',
  'src/agent-chat/agent-slack-client.ts::findInstall',
  'src/agent-execution/adapter/mcp-bridge.ts::deriveSpillTargetForTest',
  'src/agent-execution/adapter/mcp-bridge.ts::mcpToGeminiFunctions',
  'src/agent-execution/adapter/tool-result-bound.ts::turnUsageFor',
  'src/agent-execution/adapter/tools/code-session/types.ts::CODE_SESSION_TOOL',
  'src/agent-execution/branch-tracker.ts::extractBranchFromToolCalls',
  'src/agent-execution/branch-tracker.ts::writeBranchCompletionMemory',
  'src/agent-execution/certification/types.ts::CERTIFICATION_CATEGORIES',
  'src/agent-execution/constants.ts::DEFAULT_MAX_LLM_TOKENS',
  'src/agent-execution/workflow-delay-flag.ts::isWorkflowDelayStepsEnabled',
  'src/archival/service.ts::archivalService',
  'src/branding/registry.ts::REBRAND_VERSION',
  'src/connectors/connector-service-client.ts::AuthFlowKind',
  'src/connectors/connector-service-client.ts::ConnectorCapabilityEnum',
  'src/connectors/connector-service-client.ts::isConnectorServiceEnabled',
  'src/connectors/connector-service-client.ts::isShadowMode',
  'src/connectors/connector-service-client.ts::resetSharedConnectorServiceClient',
  'src/connectors/mcp-server-registry.ts::getMCPConnectorTypes',
  'src/connectors/mcp-server-registry.ts::registerMCPServer',
  'src/connectors/normalizers/index.ts::getSupportedConnectorTypes',
  'src/connectors/poller.ts::createPoller',
  'src/connectors/shadow-mode.ts::withShadowAndFallback',
  'src/connectors/tool-schema-cache.ts::getCustomMcpServerToolSchemas',
  'src/connectors/tool-schema-cache.ts::isToolSchemaCacheSeeded',
  'src/connectors/tool-schema-cache.ts::listCustomMcpServerCacheEntries',
  'src/connectors/tool-schema-cache.ts::stopToolSchemaCache',
  'src/coordinator/dispatcher.ts::resetCoordinatorDispatcherForTests',
  'src/coordinator/dispatcher.ts::setCoordinatorDispatcherForTests',
  'src/coordinator/types.ts::VALID_PHASE_TRANSITIONS',
  // Several entries in this list — the three `corrections` symbols below,
  // CODE_SESSION_TOOL, getCorrectionRegistryEntry, processDLQMessage,
  // CredentialVendingService and memory/encryption's isEncrypted — became
  // visible when the checker stopped treating a barrel re-export as a use. Each
  // is named only by an `export { … } from` line, which is not a consumer.
  // Pre-existing debt, surfaced rather than introduced.
  'src/corrections/control-plane-client.ts::getCorrectionRegistryEntry',
  'src/corrections/dlq-handler.ts::processDLQMessage',
  'src/corrections/queue.ts::enqueueCorrection',
  'src/corrections/queue.ts::getPendingCorrections',
  'src/corrections/resource-validator.ts::validateResourcesExist',
  'src/corrections/state-resolver.ts::getPreActionSnapshotWithValidation',
  'src/diagnostics/analyze/judge/deepeval-client.ts::clearDeepEvalMemo',
  'src/diagnostics/analyze/trajectory-util.ts::isToolUse',
  'src/diagnostics/reconstruct/user-catalog.ts::clearCatalogMemo',
  'src/events/runtime-config-schema.ts::RuntimeConfigUpdatedPayloadSchema',
  'src/execution-environments/credential-vending-service.ts::CredentialVendingService',
  'src/execution-environments/credit-calculator.ts::MICRO_CREDITS_PER_USD',
  'src/execution-environments/function-registry.ts::getSandboxFunction',
  'src/execution-environments/function-registry.ts::getSandboxFunctionNames',
  'src/governance/governance-events-subscriber.ts::resetGovernanceEventsSubscriber',
  'src/governance/governance-service-client.ts::AdmissionStatus',
  // HitlLevel is gone from the baseline because the export itself is gone: it
  // was a re-export nothing imported, and deleting it is the answer this list
  // asks for first. The RPC approval mapper takes HitlLevel from proto-gen,
  // which is where the rest of that wire vocabulary already comes from.
  'src/governance/governance-service-client.ts::resetSharedGovernanceServiceClient',
  'src/governance/governance-service-flag.ts::isGovernanceServiceEnabled',
  'src/governance/governance-service-flag.ts::isGovernanceShadowMode',
  'src/governance/preflight-cache.ts::resetPreflightCache',
  'src/governance/wal-drainer.ts::stopWalDrainer',
  'src/hitl-enforcement/action-trust-outbox.ts::stopActionTrustOutboxDrainer',
  'src/hitl-enforcement/gateway-pause-signal.ts::clearGatewayHitlPause',
  'src/infrastructure/circuit-breaker.ts::CircuitBreaker',
  'src/infrastructure/dlq-handlers.ts::registerDLQHandlers',
  'src/infrastructure/logging.ts::shutdownAuditLogger',
  'src/infrastructure/repository-validation.ts::validateInput',
  'src/infrastructure/runtime-env.ts::getCloudSchedulerSAEmail',
  'src/infrastructure/runtime-env.ts::getGcpProjectId',
  'src/infrastructure/secrets.ts::createOrAddSecretVersion',
  'src/infrastructure/secrets.ts::getConnectorCredential',
  'src/infrastructure/secrets.ts::getDbPassword',
  'src/infrastructure/soft-delete.ts::generateAddSoftDeleteMigration',
  'src/infrastructure/soft-delete.ts::SOFT_DELETE_COLUMNS',
  'src/infrastructure/soft-delete.ts::SoftDeleteRepository',
  'src/infrastructure/telemetry.ts::addSpanEvent',
  'src/infrastructure/telemetry.ts::createChildSpan',
  'src/infrastructure/telemetry.ts::extractContext',
  'src/infrastructure/telemetry.ts::getCurrentTraceContext',
  'src/infrastructure/telemetry.ts::injectContext',
  'src/infrastructure/telemetry.ts::recordSpanError',
  'src/infrastructure/telemetry.ts::setSpanAttributes',
  'src/infrastructure/telemetry.ts::withSpanSync',
  'src/integrations/web-fetch/rate-limiter.ts::webToolRateLimiter',
  'src/integrations/web-fetch/types.ts::toAgentDeepResearchResult',
  'src/integrations/web-fetch/types.ts::toAgentFinanceSearchResult',
  'src/integrations/web-fetch/types.ts::toAgentPeopleSearchResult',
  'src/integrations/web-fetch/types.ts::toAgentResearchResult',
  'src/integrations/web-fetch/types.ts::toAgentSessionSaveResult',
  'src/jobs/meter-reconciliation.ts::runReconciliationJob',
  'src/learning/chat-feedback-extractor.ts::extractChatFeedback',
  'src/learning/knowledge-promoter.ts::promoteSharedKnowledge',
  'src/llm/model-registry-loader.ts::stopModelRegistryRefresh',
  'src/llm/pricing.ts::getHistoricalPricing',
  'src/llm/pricing.ts::recordPricingChange',
  'src/memory/encryption.ts::clearAllKeyCache',
  'src/memory/encryption.ts::clearTenantKeyCache',
  'src/memory/encryption.ts::isEncrypted',
  'src/middleware/kill-switch-middleware.ts::clearAllKillSwitchCache',
  'src/middleware/kill-switch-middleware.ts::clearKillSwitchCache',
  'src/middleware/kill-switch-middleware.ts::strictKillSwitchMiddleware',
  'src/middleware/rate-limit-middleware.ts::actionRateLimitMiddleware',
  'src/middleware/rate-limit-middleware.ts::apiRequestRateLimitMiddleware',
  'src/middleware/rate-limit-middleware.ts::connectorWriteRateLimitMiddleware',
  'src/middleware/rate-limit-middleware.ts::createSlidingWindowMiddleware',
  'src/middleware/rate-limit-middleware.ts::workflowRateLimitMiddleware',
  'src/middleware/trace-context-middleware.ts::databaseSpanMiddleware',
  'src/middleware/trace-context-middleware.ts::externalServiceSpanMiddleware',
  'src/middleware/trace-context-middleware.ts::getRequestTraceContext',
  'src/middleware/trace-context-middleware.ts::injectTraceContext',
  'src/middleware/trace-context-middleware.ts::withOperationSpan',
  'src/observability/scrub-logger.ts::setBaseLogger',
  'src/reactive-subscriptions/feature-flag.ts::isReactiveSubscriptionsEnabled',
  'src/reactive-subscriptions/subscription-router.ts::getSubscriptionCacheForTenant',
  'src/reactive-subscriptions/subscription-router.ts::stopSubscriptionRouter',
  'src/reactive-subscriptions/wake-delivery-drain.ts::stopWakeDrainer',
  'src/reflection-engine/http-client.ts::getReflectionServiceClient',
  'src/reflection-engine/http-client.ts::resetReflectionServiceClientForTests',
  'src/scheduling/cloud-scheduler.ts::listJobsForTenant',
  'src/scheduling/cloud-scheduler.ts::runJobNow',
  'src/scheduling/companion-cron-flag.ts::isMultiCompanionCronEnabled',
  'src/scheduling/event-trigger.ts::stopEventTriggerSubscriber',
  'src/security/mcp-url-guard.ts::assertMcpRedirectAllowed',
  'src/security/mcp-url-guard.ts::isMcpUrlAllowed',
  'src/security/mcp-url-guard.ts::sanitizeVendorTools',
  'src/security/oidc-verifier.ts::resetOidcVerifierClientForTests',
  'src/security/oidc-verifier.ts::setOidcVerifierClientForTests',
  'src/security/service-auth.ts::isPublicRoute',
  'src/security/sidecar-secret.ts::SIDECAR_AUTH_HEADER',
  'src/security/ssrf-guard.ts::isSafeFetchTarget',
  'src/security/tenant-context.ts::getCurrentTenantContext',
  'src/security/tenant-context.ts::tenantContextMiddleware',
  'src/tool-gateway/dispatcher.ts::resetToolGatewayDispatcherForTests',
  'src/tool-gateway/dispatcher.ts::setToolGatewayDispatcherForTests',
  'src/tool-gateway/mcp-server.ts::discoverMCPToolsForCatalog',
  'src/tool-gateway/workspace-run-output-store.ts::clearLastOutput',
  'src/tool-gateway/workspace-tools-mcp.ts::handleWorkspaceGitClone',
  'src/tool-gateway/workspace-tools-mcp.ts::handleWorkspaceGitPush',
  'src/tool-gateway/workspace-tools-mcp.ts::handleWorkspacePackageInstall',
  'src/tool-gateway/workspace-tools-mcp.ts::handleWorkspaceRun',
  'src/tool-gateway/workspace-tools-mcp.ts::handleWorkspaceRunLastOutput',
  'src/tools/research-tools.ts::getResearchTool',
  'src/tools/research-tools.ts::getResearchToolNames',
  'src/tools/research-tools.ts::isResearchTool',
  'src/tools/standard-tools.ts::getStandardToolNames',
  'src/workspace/git-mirror.ts::ensureMirror',
  'src/workspace/path-isolation.ts::buildPathIsolationHook',
  'src/workspace/secret-scrubber.ts::clearTenantPatternCache',
];
