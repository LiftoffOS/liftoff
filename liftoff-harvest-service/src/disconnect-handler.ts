import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { getPool } from './infrastructure/database';
import { log } from './infrastructure/logging';
import { resolveRuntimeUrl } from './memory-client';

const HARVEST_TENANT_RUNTIME_SERVICE_TOKEN =
  process.env.HARVEST_TENANT_RUNTIME_SERVICE_TOKEN ?? '';

export async function handleConnectorDeleted(
  connectorId: string,
  tenantId: string,
): Promise<void> {
  const runtimeUrl = await resolveRuntimeUrl(tenantId);
  const oidcHeaders = await buildOidcAuthHeader(runtimeUrl);
  const serviceAuthHeaders = {
    'x-tenant-id': tenantId,
    'X-Service-Auth': HARVEST_TENANT_RUNTIME_SERVICE_TOKEN,
    ...oidcHeaders,
  };

  // PATH 1: Provenance graph erasure (post-migration memories + all synthesized descendants)
  let graphDeleted = 0;
  try {
    const res = await fetch(`${runtimeUrl}/api/internal/provenance/connector/${connectorId}`, {
      method: 'DELETE',
      headers: { ...serviceAuthHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });
    if (res.ok) {
      const body = await res.json() as { deleted: number };
      graphDeleted = body.deleted;
    } else {
      log.warn({ status: res.status, connectorId }, 'provenance erasure returned unexpected status');
    }
  } catch (err) {
    log.warn({ error: (err as Error).message, connectorId }, 'provenance erasure threw (continuing)');
  }

  // PATH 2: harvest_entities fallback (pre-migration directly-harvested memories)
  // Memories already deleted by Path 1 return 404; that is treated as success (overlap is fine)
  //
  // harvest_entities is keyed by (connector_id, entity_id) and has NO tenant_id
  // column — connector ids are globally unique, so connector_id alone is the
  // scope (the DELETE below already relies on this). The previous version
  // filtered on a phantom tenant_id column, which made every connector.deleted
  // cleanup throw 42703 and nack since the dual-path erasure shipped.
  const entityRows = await getPool().query<{ memory_id: string | null }>(
    'SELECT memory_id FROM harvest_entities WHERE connector_id = $1 AND memory_id IS NOT NULL',
    [connectorId],
  );
  let fallbackDeleted = 0;
  for (const row of entityRows.rows) {
    try {
      const res = await fetch(`${runtimeUrl}/api/memory/${row.memory_id}`, {
        method: 'DELETE',
        headers: serviceAuthHeaders,
      });
      if (res.ok || res.status === 404) fallbackDeleted++;
      else
        log.warn(
          { memoryId: row.memory_id, status: res.status },
          'fallback delete unexpected status',
        );
    } catch (err) {
      log.warn(
        { memoryId: row.memory_id, error: (err as Error).message },
        'fallback delete threw (skipping)',
      );
    }
  }

  // Cleanup harvest_entities (same as existing pattern)
  await getPool().query('DELETE FROM harvest_entities WHERE connector_id = $1', [connectorId]);

  log.info({ connectorId, tenantId, graphDeleted, fallbackDeleted }, 'connector disconnect cleanup complete');
}
