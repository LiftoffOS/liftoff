import { getPool } from './infrastructure/database';
import { log } from './infrastructure/logging';
import type { CostEvent } from './types';

/**
 * Insert a cost event row. Cost-log failures must never block the memory
 * write path — we catch and swallow any DB error here.
 *
 * ON CONFLICT DO NOTHING: the unique index on (message_id, occurred_at)
 * guards against double-inserts during replay (when harvest_dedup is
 * truncated). message_id is always set by the Pub/Sub runner.
 */
export async function logCostEvent(event: CostEvent): Promise<void> {
  const sql = `
    INSERT INTO harvest_cost_events (
      tenant_id, connector_id, connector_type, entity_type,
      model, input_tokens, output_tokens, cost_usd,
      memory_type, worthy, source_record_id, message_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (message_id, occurred_at) DO NOTHING
  `;

  try {
    await getPool().query(sql, [
      event.tenantId,
      event.connectorId,
      event.connectorType,
      event.entityType,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.costUsd,
      event.memoryType,
      event.worthy,
      event.sourceRecordId,
      event.messageId,
    ]);
  } catch (err) {
    log.error(
      { error: (err as Error).message, tenantId: event.tenantId, connectorType: event.connectorType },
      'cost-log insert failed (swallowed — does not block memory write)',
    );
  }
}
