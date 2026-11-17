import { log } from '../infrastructure/logging';
import { buildOidcAuthHeader } from '@liftoffos/service-client';

const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL ?? '';
const CONNECTOR_SERVICE_URL = process.env.CONNECTOR_SERVICE_URL ?? '';
const HARVEST_SERVICE_TOKEN = process.env.HARVEST_SERVICE_TOKEN ?? '';
const CONNECTOR_SERVICE_TOKEN = process.env.CONNECTOR_SERVICE_TOKEN ?? '';

interface ConnectorEntry { id: string; type: string; status: string }

async function getHarvestEnabledTenants(): Promise<string[]> {
  const oidcHeaders = await buildOidcAuthHeader(PLATFORM_BACKEND_URL);
  const res = await fetch(`${PLATFORM_BACKEND_URL}/api/internal/harvest/enabled-tenants`, {
    headers: { 'X-Service-Auth': HARVEST_SERVICE_TOKEN, ...oidcHeaders },
  });
  if (!res.ok) throw new Error(`enabled-tenants failed: ${res.status}`);
  const body = (await res.json()) as { tenantIds: string[] };
  return body.tenantIds;
}

async function getActiveConnectors(tenantId: string): Promise<ConnectorEntry[]> {
  const oidcHeaders = await buildOidcAuthHeader(CONNECTOR_SERVICE_URL);
  const res = await fetch(
    `${CONNECTOR_SERVICE_URL}/api/connectors?tenantId=${tenantId}&status=active`,
    { headers: { 'X-Service-Auth': CONNECTOR_SERVICE_TOKEN, ...oidcHeaders } },
  );
  if (!res.ok) {
    log.warn({ tenantId, status: res.status }, 'connector list failed; skipping tenant');
    return [];
  }
  const body = (await res.json()) as { connectors: ConnectorEntry[] };
  return body.connectors ?? [];
}

async function triggerSync(connectorId: string, backfill: boolean): Promise<void> {
  const endpoint = backfill ? 'sync/backfill' : 'sync/force';
  const oidcHeaders = await buildOidcAuthHeader(CONNECTOR_SERVICE_URL);
  const res = await fetch(`${CONNECTOR_SERVICE_URL}/api/connectors/${connectorId}/${endpoint}`, {
    method: 'POST',
    headers: { 'X-Service-Auth': CONNECTOR_SERVICE_TOKEN, ...oidcHeaders },
  });
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status}`);
}

async function main(): Promise<void> {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex !== -1 ? (process.argv[modeIndex + 1] ?? 'reharvest') : 'reharvest';
  const isBackfill = mode === 'backfill';

  log.info({ mode }, `${mode} job starting`);
  const tenantIds = await getHarvestEnabledTenants();
  log.info({ tenantCount: tenantIds.length }, 'fetched harvest-enabled tenants');

  let triggered = 0, skipped = 0;
  for (const tenantId of tenantIds) {
    const connectors = await getActiveConnectors(tenantId);
    for (const connector of connectors) {
      try {
        await triggerSync(connector.id, isBackfill);
        triggered++;
      } catch (err) {
        log.warn({ connectorId: connector.id, tenantId, error: (err as Error).message },
          `${mode} sync failed; skipping`);
        skipped++;
      }
    }
  }

  log.info({ triggered, skipped, mode }, `${mode} job complete`);
}

if (require.main === module) {
  main().catch((err) => {
    log.error({ error: (err as Error).message }, 're-harvest job failed');
    process.exit(1);
  });
}
