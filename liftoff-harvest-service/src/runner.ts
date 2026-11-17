import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { getPool } from './infrastructure/database';
import { log } from './infrastructure/logging';
import { shouldAttemptClassification, extractText } from './filter';
import { classifyWithUsage } from './classifier';
import { isTerminalGatewayError, LlmGatewayError } from './llm-client';
import { computeCostUsd } from './pricing';
import { logCostEvent } from './cost-log';
import { writeMemory } from './memory-client';
import { computeContentHash, lookupEntity, upsertEntity, needsTtlRefresh } from './change-detection';
import { computeExpiresAt } from './ttl';
import { chunkText } from './chunker';
import type { ClassificationResult, HarvestEvent } from './types';

const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL ?? 'http://localhost:3000';
const HARVEST_SERVICE_TOKEN = process.env.HARVEST_SERVICE_TOKEN ?? '';

/**
 * SEC-001: Validate that connectorId belongs to the stated tenantId.
 * Calls platform-backend's internal connector ownership endpoint.
 * Fail-closed on any error — a connector-id mismatch could allow one
 * tenant to trigger memory writes into another tenant's runtime.
 */
async function validateConnectorOwnership(connectorId: string, tenantId: string): Promise<boolean> {
  try {
    const oidcHeaders = await buildOidcAuthHeader(PLATFORM_BACKEND_URL);
    const res = await fetch(
      `${PLATFORM_BACKEND_URL}/api/internal/connectors/${connectorId}/tenant`,
      { headers: { 'X-Service-Auth': HARVEST_SERVICE_TOKEN, ...oidcHeaders } },
    );
    if (res.status === 404) {
      log.warn({ connectorId, tenantId }, 'SEC-001: connector not found in platform-backend; failing closed');
      return false;
    }
    if (!res.ok) {
      log.warn({ connectorId, tenantId, status: res.status }, 'SEC-001: connector ownership check failed; failing closed');
      return false;
    }
    const body = (await res.json()) as { tenantId?: string; tenant_id?: string };
    const ownerTenantId = body.tenantId ?? body.tenant_id;
    if (!ownerTenantId || ownerTenantId !== tenantId) {
      log.error({ connectorId, claimedTenantId: tenantId, actualTenantId: ownerTenantId }, 'SEC-001: tenantId mismatch — rejecting message');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ connectorId, tenantId, error: (err as Error).message }, 'SEC-001: connector ownership check threw; failing closed');
    return false;
  }
}

/**
 * TENANT-OPT-001: Check whether harvest is enabled for this tenant.
 * Fail-closed: missing tenant record or any non-200 response → disabled.
 * The plan specifies DEFAULT false (opt-in); fail-closed upholds that
 * invariant even during platform-backend transient errors.
 */
async function isTenantHarvestEnabled(tenantId: string): Promise<boolean> {
  try {
    const oidcHeaders = await buildOidcAuthHeader(PLATFORM_BACKEND_URL);
    const res = await fetch(
      `${PLATFORM_BACKEND_URL}/api/internal/tenants/${tenantId}/features/harvest`,
      { headers: { 'X-Service-Auth': HARVEST_SERVICE_TOKEN, ...oidcHeaders } },
    );
    if (!res.ok) {
      log.warn(
        { tenantId, status: res.status },
        'TENANT-OPT-001: harvest feature check returned non-200; failing closed (harvest disabled for tenant)',
      );
      return false;
    }
    const body = (await res.json()) as { enabled?: boolean };
    return body.enabled === true;
  } catch (err) {
    log.warn(
      { tenantId, error: (err as Error).message },
      'TENANT-OPT-001: harvest feature check threw; failing closed (harvest disabled for tenant)',
    );
    return false;
  }
}

/**
 * INF-001: Upfront-claim idempotency. The INSERT is atomic — if two
 * concurrent Pub/Sub deliveries race here, exactly one will get a returned
 * row and proceed; the other returns rowCount=0 and bails out. This is
 * safer than SELECT-then-INSERT-at-end, which has a TOCTOU race window.
 *
 * Returns true if this delivery successfully claimed the message (proceed).
 * Returns false if another delivery already claimed it (skip).
 */
async function claimMessage(messageId: string): Promise<boolean> {
  const result = await getPool().query<{ message_id: string }>(
    'INSERT INTO harvest_dedup (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id',
    [messageId],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function runHarvestPipeline(event: HarvestEvent): Promise<void> {
  // 1. Upfront-claim idempotency (INF-001). Atomically claim this message_id;
  //    bail if another concurrent delivery has already claimed it.
  const claimed = await claimMessage(event.messageId);
  if (!claimed) {
    log.info({ messageId: event.messageId }, 'skipping duplicate message (already claimed by concurrent delivery)');
    return;
  }

  // TENANT-OPT-001: per-tenant harvest killswitch
  const harvestEnabled = await isTenantHarvestEnabled(event.tenantId);
  if (!harvestEnabled) {
    log.info({ tenantId: event.tenantId }, 'harvest disabled for tenant, skipping');
    log.info({ metric: 'harvest_dropped', reason: 'tenant_disabled', tenant_id: event.tenantId }, 'harvest:metric');
    return;
  }

  // SEC-001: Validate connectorId → tenantId ownership
  if (event.connectorId) {
    const ownershipValid = await validateConnectorOwnership(event.connectorId, event.tenantId);
    if (!ownershipValid) {
      log.info({ metric: 'harvest_dropped', reason: 'ownership_mismatch', tenant_id: event.tenantId }, 'harvest:metric');
      return;
    }
  }

  // 2. Pre-filter
  if (!shouldAttemptClassification(event)) {
    log.debug(
      { entityType: event.entityType, connectorType: event.connectorType },
      'pre-filter: skipped',
    );
    log.info({ metric: 'harvest_dropped', reason: 'pre_filter', tenant_id: event.tenantId }, 'harvest:metric');
    return;
  }

  // 3. Extract text (already validated by the filter, but we need the value)
  const rawText = extractText(event);
  if (!rawText) return;

  // Phase 2: change detection — skip unchanged content unless TTL refresh needed
  let contentHash: string | null = null;
  if (event.connectorId) {
    contentHash = computeContentHash(rawText);
    const prior = await lookupEntity(event.connectorId, event.entityId);
    if (prior && prior.contentHash === contentHash && !needsTtlRefresh(prior)) {
      log.info(
        { metric: 'harvest_dropped', reason: 'unchanged', tenant_id: event.tenantId,
          connector_type: event.connectorType },
        'harvest:metric',
      );
      return;
    }
  }

  // 4. Classify
  const usageContext: Record<string, string> = {
    purpose: 'harvest_classification',
    tenantId: event.tenantId,
    connectorType: event.connectorType,
    entityType: event.entityType,
    ...(event.connectorId ? { connectorId: event.connectorId } : {}),
  };

  let result: ClassificationResult | null = null;
  let fullText = rawText;
  let model = 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;
  let droppedReason: string | undefined;

  try {
    const outcome = await classifyWithUsage(
      rawText,
      event.connectorType,
      event.entityType,
      usageContext,
    );
    result = outcome.classification;
    fullText = outcome.fullText;
    droppedReason = outcome.droppedReason;
    model = outcome.model;
    inputTokens = outcome.inputTokens;
    outputTokens = outcome.outputTokens;
    // OPS-001: harvest_classified metric (includes unworthy calls — LLM token was spent)
    log.info({ metric: 'harvest_classified', worthy: result !== null, tenant_id: event.tenantId, connector_type: event.connectorType }, 'harvest:metric');
  } catch (err) {
    // BILLING-GATE: a terminal 4xx from the platform-backend LLM gateway (the
    // tenant is suspended / not execution-allowed, or a scoping error) is a
    // verdict that will not change on retry. Ack-and-skip rather than nack —
    // nacking a 4xx just burns the Pub/Sub retry budget and DLQs the message.
    // No cost log / no memory write: the gateway refused before calling the
    // model, so no LLM token was actually spent.
    if (isTerminalGatewayError(err)) {
      log.info(
        {
          metric: 'harvest_dropped',
          reason: 'tenant_not_execution_allowed',
          tenant_id: event.tenantId,
          status: (err as LlmGatewayError).status,
        },
        'harvest:metric',
      );
      return;
    }
    log.error(
      { error: (err as Error).message, tenantId: event.tenantId },
      'classifier failed',
    );
    throw err; // nack the message (retryable: 5xx / network)
  }

  // 5. Cost log (always, regardless of worthiness)
  const costUsd = computeCostUsd(model, inputTokens, outputTokens);
  await logCostEvent({
    tenantId: event.tenantId,
    connectorId: event.connectorId,
    connectorType: event.connectorType,
    entityType: event.entityType,
    model,
    inputTokens,
    outputTokens,
    costUsd,
    memoryType: result?.memoryType ?? null,
    worthy: result !== null,
    sourceRecordId: event.entityId,
    messageId: event.messageId,
  });

  // 6. Write memory if worthy
  if (result) {
    if (!result.extractedContent) {
      // Classifier flagged the message as worthy but produced no content
      // — nothing to persist. Skip the memory write rather than nacking
      // (the LLM token has already been spent and logged).
      log.warn(
        { tenantId: event.tenantId, entityId: event.entityId },
        'classifier returned worthy result with no extractedContent; skipping memory write',
      );
      log.info(
        { metric: 'harvest_dropped', reason: 'no_extracted_content', tenant_id: event.tenantId },
        'harvest:metric',
      );
    } else {
      try {
        const chunks = chunkText(fullText, { maxChunks: 20 });
        let firstMemoryId: string | null = null;

        for (const chunk of chunks) {
          const chunkResult: ClassificationResult = {
            ...result,
            extractedContent: chunk.text,
            suggestedTags: [
              ...(result.suggestedTags ?? []),
              `harvest:chunk:${chunk.chunkIndex}`,
              `harvest:entity:${event.connectorId ?? 'unknown'}:${event.entityId}`,
            ],
          };
          const memoryId = await writeMemory(event.tenantId, chunkResult, event);
          if (chunk.chunkIndex === 0) firstMemoryId = memoryId;
        }

        log.info(
          {
            tenantId: event.tenantId,
            memoryType: result.memoryType,
            connectorType: event.connectorType,
            chunkCount: chunks.length,
          },
          'memory written',
        );
        // OPS-001: harvest_written metric
        log.info({ metric: 'harvest_written', memory_type: result.memoryType, tenant_id: event.tenantId, connector_type: event.connectorType }, 'harvest:metric');
        if (event.connectorId && contentHash) {
          await upsertEntity({
            connectorId: event.connectorId,
            entityId: event.entityId,
            contentHash,
            memoryId: firstMemoryId,
            memoryType: result.memoryType ?? null,
            expiresAt: result.memoryType ? new Date(computeExpiresAt(result.memoryType)) : null,
          }).catch((err) => {
            log.warn({ error: (err as Error).message }, 'upsertEntity failed (non-fatal)');
          });
        }
      } catch (err) {
        log.error(
          { error: (err as Error).message, tenantId: event.tenantId },
          'memory write failed',
        );
        throw err; // nack so message is retried
      }
    }
  } else {
    // OPS-001: count dropped messages; droppedReason distinguishes unworthy
    // from low_confidence so each can be tracked separately.
    log.info({ metric: 'harvest_dropped', reason: droppedReason ?? 'unworthy', tenant_id: event.tenantId, connector_type: event.connectorType }, 'harvest:metric');
    if (event.connectorId && contentHash) {
      await upsertEntity({
        connectorId: event.connectorId,
        entityId: event.entityId,
        contentHash,
        memoryId: null,
        memoryType: null,
        expiresAt: null,
      }).catch((err) => {
        log.warn({ error: (err as Error).message }, 'upsertEntity (unworthy) failed (non-fatal)');
      });
    }
  }
}
