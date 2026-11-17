// Connect-RPC clients for every service that implements ExportTenantData +
// DeleteTenantUserData (Phase 0s DSAR orchestrator).
//
// Each client is instantiated once per orchestrator invocation and reused
// across requests. Service URLs are resolved from env vars:
//   {SERVICE_ENV_VAR}_SERVICE_URL — base URL of the Cloud Run service.
//   {SERVICE_ENV_VAR}_SERVICE_TOKEN — X-Service-Auth shared token.

import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import {
  BillingService,
  DeveloperProxyService,
  WorkforceService,
  ConnectorService,
  GovernanceService,
  TenantRuntimeService,
} from '@liftoffos/proto-gen';

// Platform-backend has no ExportTenantData proto (it acts as the orchestrator
// itself, not a target). Its data is handled inline by the orchestrator.
const SERVICE_MAP = {
  'liftoff-billing': { service: BillingService, envKey: 'BILLING' },
  'liftoff-developer-proxy': { service: DeveloperProxyService, envKey: 'DEVELOPER_PROXY' },
  'liftoff-workforce-service': { service: WorkforceService, envKey: 'WORKFORCE' },
  'liftoff-connector-service': { service: ConnectorService, envKey: 'CONNECTOR' },
  'liftoff-governance-engine': { service: GovernanceService, envKey: 'GOVERNANCE' },
  'liftoff-tenant-runtime': { service: TenantRuntimeService, envKey: 'TENANT_RUNTIME' },
} as const;

type ServiceName = keyof typeof SERVICE_MAP | 'liftoff-platform-backend';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyServiceClient = Client<any>;

const _cache = new Map<string, AnyServiceClient>();

export function getServiceClient(serviceName: ServiceName): AnyServiceClient | null {
  if (serviceName === 'liftoff-platform-backend') return null;
  if (_cache.has(serviceName)) return _cache.get(serviceName)!;

  const entry = SERVICE_MAP[serviceName as keyof typeof SERVICE_MAP];
  const baseUrl = process.env[`${entry.envKey}_SERVICE_URL`];
  if (!baseUrl) {
    console.warn(`[orchestrator] ${entry.envKey}_SERVICE_URL not set — ${serviceName} will be skipped`);
    return null;
  }
  const token = process.env[`${entry.envKey}_SERVICE_TOKEN`] ?? '';

  const transport = createConnectTransport({
    baseUrl,
    httpVersion: '2',
    interceptors: [
      (next) => async (req) => {
        req.header.set('x-service-auth', token);
        try {
          const oidc = await buildOidcAuthHeader(baseUrl);
          for (const [k, v] of Object.entries(oidc)) req.header.set(k, v);
        } catch {
          // Tolerate OIDC failures in dev (no metadata server)
        }
        return next(req);
      },
    ],
  });

  const client = createClient(entry.service, transport);
  _cache.set(serviceName, client);
  return client;
}

export function clearClientCache(): void {
  _cache.clear();
}
