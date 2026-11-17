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

export const KNOWN_ORPHAN_EXPORTS: readonly string[] = [
  'src/a2a/types.ts::WORKFLOW_TO_A2A_STATUS',
  'src/accounts/hashing.ts::hashPhone',
  'src/agent-chat/multi-agent-service.ts::runMultiAgentChatTurnAsync',
  'src/agent-chat/slack-adapter/slack-streamer.ts::buildSlackFileBlocks',
  'src/agent-chat/teams-adapter/teams-secret-service.ts::readAdminRefreshToken',
  'src/agent-chat/turn-events-repository.ts::getLiveTurnId',
  // Eight entries in this list — getAllTemplates, getDisabledReason,
  // automatedEvidenceCollector, refreshSingleAgentToken, checkSingleAgentHealth,
  // startSyncJob, stopSyncJob and tenantMembersRepository — became visible when
  // the checker stopped treating a barrel re-export as a use. Each is named only
  // by an `export { … } from` line, which is not a consumer. Pre-existing debt,
  // surfaced rather than introduced.
  'src/agent-templates/loader.ts::getAllTemplates',
  'src/agent-templates/loader.ts::getDisabledReason',
  'src/agent-templates/loader.ts::getTemplateAtVersion',
  'src/agent-templates/validator.ts::fromTemplatePreviewRequestZodSchema',
  'src/agent-templates/validator.ts::fromTemplateRequestZodSchema',
  'src/agent-templates/validator.ts::validateTemplate',
  'src/auth/jwt.ts::verifyAuthHeader',
  'src/billing/provisioning-outbox-worker.ts::stopProvisioningOutboxLoop',
  'src/branding/registry-branding-loader.ts::stopRegistryModelBrandingRefresh',
  'src/claude-code-proxy/types.ts::selfRevokeSchema',
  'src/compliance/data-residency/service.ts::dataResidencyService',
  'src/compliance/evidence/automated-collection.ts::automatedEvidenceCollector',
  'src/connectors/connector-service-cache.ts::getCacheSource',
  'src/connectors/connector-service-cache.ts::scopesForConnector',
  'src/connectors/connector-service-cache.ts::stopConnectorServiceCache',
  'src/connectors/connector-service-client.ts::AuthFlowKind',
  'src/connectors/connector-service-client.ts::resetSharedConnectorServiceClient',
  'src/connectors/tenant-runtime-service-client.ts::resetTenantRuntimeServiceClientCache',
  'src/corrections/billing.ts::handleFinancialCorrection',
  'src/corrections/budget.ts::checkBudget',
  'src/corrections/budget.ts::getBudgetInfo',
  'src/corrections/permissions.ts::checkRequireOriginalActor',
  'src/corrections/permissions.ts::getTriggeredByPrefix',
  'src/corrections/permissions.ts::isValidTriggeredBy',
  'src/corrections/rate-limiter.ts::checkBulkRateLimit',
  'src/cost-attribution/composio-pricing.ts::composioCallsToCostUsd',
  'src/cost-attribution/ingestion/backfill-correlator.ts::runBackfillCorrelator',
  'src/event-sources/permission-keys.ts::stripPermissionKeys',
  'src/external-agents/credential-refresh-service.ts::refreshSingleAgentToken',
  'src/external-agents/health-check-service.ts::checkSingleAgentHealth',
  'src/events/outbox.ts::stopControlPlaneOutboxWorker',
  'src/events/publisher.ts::publishEvents',
  'src/hitl-late-feedback/trust-outbox.ts::stopLateFeedbackTrustOutboxWorker',
  'src/infrastructure/database.ts::getPoolForService',
  'src/infrastructure/email/index.ts::sendPasswordResetEmail',
  'src/infrastructure/email/index.ts::sendTeamInviteEmail',
  'src/infrastructure/http-logging.ts::logOutboundRequest',
  'src/infrastructure/logging.ts::shutdownAuditLogger',
  'src/infrastructure/secrets.ts::clearSecretCache',
  'src/infrastructure/secrets.ts::clearSecretCacheEntry',
  'src/infrastructure/secrets.ts::getSecretName',
  'src/infrastructure/secrets.ts::getStripeWebhookSecret',
  'src/infrastructure/secrets.ts::getTenantSecret',
  'src/infrastructure/secrets.ts::loadSecrets',
  'src/infrastructure/secrets.ts::REQUIRED_SECRETS',
  'src/infrastructure/soft-delete.ts::generateFullSoftDeleteMigration',
  'src/infrastructure/soft-delete.ts::SOFT_DELETE_COLUMNS',
  'src/infrastructure/soft-delete.ts::SoftDeleteRepository',
  'src/insights/tools/dispatcher.ts::getRegisteredTool',
  'src/internal-agents/agent-teams-distill-tools.ts::AGENT_TEAMS_DISTILL_PROMPT_NOTE',
  'src/internal-agents/outbox.ts::stopInternalAgentOutboxWorker',
  'src/internal-agents/quotas.ts::assertReactiveSubscriptionQuotas',
  'src/internal-agents/trigger-config-analyzer.ts::asCatalogResponse',
  'src/jobs/sync-late-feedback.ts::startSyncJob',
  'src/jobs/sync-late-feedback.ts::stopSyncJob',
  'src/knowledge/outbox.ts::stopKnowledgeOutboxWorker',
  'src/knowledge/repository.ts::findByParentId',
  'src/llm/model-pricing-loader.ts::stopModelPricingRefresh',
  'src/llm/registry-tier-loader.ts::stopRegistryTierRefresh',
  'src/mcp/tool-classifier.ts::FAIL_SECURE_ACTION_CATEGORIES',
  'src/mcp/tool-classifier.ts::mapSensitivityToActionCategories',
  'src/rollout/health-monitor-job.ts::rolloutHealthMonitorJob',
  'src/rollout/step-advancement-job.ts::rolloutStepAdvancementJob',
  'src/rollout/worker.ts::isRolloutWorkerRunning',
  'src/rollout/worker.ts::startRolloutWorker',
  'src/rollout/worker.ts::stopRolloutWorker',
  'src/tenant-members/repository.ts::tenantMembersRepository',
  'src/web-identities/service.ts::revokeIdentity',
];
