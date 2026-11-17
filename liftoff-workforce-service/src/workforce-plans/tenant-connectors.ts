// Tenant connectors — workforce-plans adapter that fetches connector data
// from platform-backend via HTTP.
//
// In platform-backend, this module calls connector-service via gRPC. In this
// standalone service, connector data is fetched from PB's REST API with a
// service-to-service bearer token.
//
// Behaviour contract:
//   - Returns only rows that are NOT disconnected (callers treat the
//     "present in the list" signal as "credential exists").
//   - Never throws — but it reports a lookup failure as a failure rather than
//     as an empty list. It used to return `[]` either way, and the callers'
//     "no connectors" branch then told people with a dozen connected apps that
//     their workspace was empty. A tool that cannot see must say so.

import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';

/** Runtime statuses accepted by workforce-plans callers. */
export type TenantConnectorStatus =
  | 'pending'
  | 'active'
  | 'error'
  | 'disabled';

/** Lightweight view callers need. */
export interface TenantConnector {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  /** Humanised name from the connector catalog. */
  displayName: string;
  status: TenantConnectorStatus;
}

/** Either the tenant's connectors, or the fact that we could not find out.
 *  The distinction is the whole point: "none connected" and "could not check"
 *  read identically to a caller that only gets an array, and the CAIO stated
 *  the first with total confidence while the truth was the second. */
export type TenantConnectorsResult =
  | { ok: true; connectors: TenantConnector[] }
  | { ok: false; reason: string };

export interface ListTenantConnectorsOptions {
  /** Optional filter on connector type (canonical snake_case ids). */
  types?: string[];
  /** Optional filter on status. */
  statuses?: string[];
}

const KNOWN_STATUSES: ReadonlySet<TenantConnectorStatus> = new Set([
  'pending',
  'active',
  'error',
  'disabled',
]);

function coerceStatus(raw: string): TenantConnectorStatus | null {
  if (KNOWN_STATUSES.has(raw as TenantConnectorStatus)) {
    return raw as TenantConnectorStatus;
  }
  // 'disconnected' is filtered out so callers never see it.
  return null;
}

function getPlatformBackendUrl(): string {
  return loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
}

/**
 * Fetch the tenant's connector rows from platform-backend.
 *
 * Uses /api/internal/connectors, not /api/connectors. The latter sits below
 * platform-backend's `app.use('/api', authMiddleware)`, which expects a Firebase
 * ID token; this service has a shared service token, so every call 401'd and
 * fell into the catch. The internal route is the same proxy behind a
 * service-token guard.
 */
export async function listTenantConnectors(
  tenantId: string,
  _options: ListTenantConnectorsOptions = {},
): Promise<TenantConnectorsResult> {
  try {
    const baseUrl = getPlatformBackendUrl();
    const url = `${baseUrl}/api/internal/connectors?tenantId=${encodeURIComponent(tenantId)}`;
    const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);

    const res = await fetch(url, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from platform-backend /api/internal/connectors`);
    }

    const body = await res.json() as { connectors?: Array<{
      id: string;
      tenantId?: string;
      type?: string;
      connectorType?: string;
      name?: string;
      displayName?: string;
      status?: string;
    }> };

    const connectors = body.connectors ?? [];
    const rows: TenantConnector[] = [];

    for (const c of connectors) {
      const status = coerceStatus(c.status ?? '');
      if (!status) continue; // drop 'disconnected' and unknown
      const connType = c.connectorType ?? c.type ?? '';
      rows.push({
        id: c.id,
        tenantId,
        type: connType,
        name: c.name || c.displayName || connType,
        displayName: c.displayName || c.name || connType,
        status,
      });
    }
    return { ok: true, connectors: rows };
  } catch (err) {
    log.warn(
      {
        event: 'workforce_plans_list_connectors_failed',
        tenantId,
        error: (err as Error).message,
      },
      'listTenantConnectors HTTP call failed — reporting a lookup failure, not an empty workspace',
    );
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Thin facade preserving the `new ConnectorService().listByTenant(...)`
 * call pattern used by the HRBP Agent (it holds a member instance so the
 * unit tests can swap the dependency via the `listConnectors` option).
 */
export class WorkforcePlansConnectorClient {
  async listByTenant(
    tenantId: string,
    options?: ListTenantConnectorsOptions,
  ): Promise<TenantConnectorsResult> {
    return listTenantConnectors(tenantId, options);
  }
}

/** Shared singleton — the default source callers import. */
export const workforcePlansConnectorClient = new WorkforcePlansConnectorClient();
