import { createHash } from 'crypto';
import { getPool } from './infrastructure/database';
import { MEMORY_TYPE_TTL_DAYS } from './ttl';
import type { MemoryType } from './types';

export function computeContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface EntityRecord {
  contentHash: string;
  memoryId: string | null;
  memoryType: string | null;
  expiresAt: Date | null;
}

export async function lookupEntity(
  connectorId: string,
  entityId: string,
): Promise<EntityRecord | null> {
  const result = await getPool().query<{
    content_hash: string;
    memory_id: string | null;
    memory_type: string | null;
    expires_at: Date | null;
  }>(
    `SELECT content_hash, memory_id, memory_type, expires_at
     FROM harvest_entities
     WHERE connector_id = $1 AND entity_id = $2`,
    [connectorId, entityId],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    contentHash: row.content_hash,
    memoryId: row.memory_id,
    memoryType: row.memory_type,
    expiresAt: row.expires_at,
  };
}

export async function upsertEntity(params: {
  connectorId: string;
  entityId: string;
  contentHash: string;
  memoryId?: string | null;
  memoryType?: string | null;
  expiresAt?: Date | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO harvest_entities
       (connector_id, entity_id, content_hash, memory_id, memory_type, expires_at, last_harvested_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (connector_id, entity_id) DO UPDATE
       SET content_hash      = EXCLUDED.content_hash,
           memory_id         = COALESCE(EXCLUDED.memory_id, harvest_entities.memory_id),
           memory_type       = COALESCE(EXCLUDED.memory_type, harvest_entities.memory_type),
           expires_at        = COALESCE(EXCLUDED.expires_at, harvest_entities.expires_at),
           last_harvested_at = now()`,
    [
      params.connectorId,
      params.entityId,
      params.contentHash,
      params.memoryId ?? null,
      params.memoryType ?? null,
      params.expiresAt ?? null,
    ],
  );
}

export function needsTtlRefresh(prior: EntityRecord): boolean {
  if (!prior.expiresAt) return false;
  const ttlDays = prior.memoryType
    ? (MEMORY_TYPE_TTL_DAYS[prior.memoryType as MemoryType] ?? 90)
    : 90;
  const refreshThreshold = new Date(prior.expiresAt);
  refreshThreshold.setDate(refreshThreshold.getDate() - Math.floor(ttlDays / 2));
  return new Date() >= refreshThreshold;
}
