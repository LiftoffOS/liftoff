// Connector Service Client (Connect-RPC) — tenant-runtime side.
//
// Thin wrapper over @connectrpc/connect's `createClient` targeting the
// proto-defined ConnectorService. Used by tool-gateway's executeConnectorCall
// under shadow/on modes.

import {
  createClient,
  ConnectError,
  Code,
  type Interceptor,
  type Client,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { ConnectorService } from '@liftoffos/proto-gen';
import * as connectorServiceNs from '@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb';
import * as connectorTypesNs from '@liftoffos/proto-gen/dist/liftoff/connector/v1/types_pb';
import { getManagedSecret } from '../infrastructure/secret-store';

// ── Feature flag ────────────────────────────────────────────────────────

export type ConnectorServiceMode = 'off' | 'shadow' | 'on';

export function getConnectorServiceMode(): ConnectorServiceMode {
  const raw = (process.env.CONNECTOR_SERVICE_ENABLED ?? 'off').toLowerCase();
  if (raw === 'shadow' || raw === 'on') return raw;
  return 'off';
}

export function isConnectorServiceEnabled(): boolean {
  return getConnectorServiceMode() !== 'off';
}

export function isShadowMode(): boolean {
  return getConnectorServiceMode() === 'shadow';
}

export { ConnectError, Code, ConnectorService };

// Re-export proto types so callers don't need deep imports.
export type ExecuteRequest = connectorServiceNs.ExecuteRequest;
export type ExecuteResponse = connectorServiceNs.ExecuteResponse;
export type ExecuteBatchRequest = connectorServiceNs.ExecuteBatchRequest;
export type ExecuteBatchResponse = connectorServiceNs.ExecuteBatchResponse;
export type WarmRequest = connectorServiceNs.WarmRequest;
export type WarmResponse = connectorServiceNs.WarmResponse;
export type WarmFailure = connectorServiceNs.WarmFailure;
export type GetCredentialsRequest = connectorServiceNs.GetCredentialsRequest;
export type GetCredentialsResponse = connectorServiceNs.GetCredentialsResponse;
export type GetFunctionalTypesRequest = connectorServiceNs.GetFunctionalTypesRequest;
export type GetFunctionalTypesResponse = connectorServiceNs.GetFunctionalTypesResponse;
export type GetCapabilitiesRequest = connectorServiceNs.GetCapabilitiesRequest;
export type GetCapabilitiesResponse = connectorServiceNs.GetCapabilitiesResponse;
export const AuthFlowKind = connectorTypesNs.AuthFlowKind;
export const ConnectorCapabilityEnum = connectorTypesNs.ConnectorCapability;

// ── Client factory ──────────────────────────────────────────────────────

export interface ConnectorServiceClientOptions {
  baseUrl?: string;
  extraInterceptors?: Interceptor[];
}

function resolveBaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.CONNECTOR_SERVICE_URL;
  if (!url) {
    throw new Error('CONNECTOR_SERVICE_URL is not set (or pass options.baseUrl)');
  }
  return url;
}

function defaultAuthInterceptor(baseUrl: string): Interceptor {
  return (next) => async (req) => {
    const token = getManagedSecret('CONNECTOR_SERVICE_TOKEN');
    if (token) req.header.set('X-Service-Auth', token);
    try {
      const oidc = await buildOidcAuthHeader(baseUrl);
      for (const [k, v] of Object.entries(oidc)) {
        req.header.set(k, v);
      }
    } catch {
      // OIDC fetch silently skips in local dev (no metadata server).
    }
    return next(req);
  };
}

let sharedClient: Client<typeof ConnectorService> | null = null;

/**
 * Phase 1a-ii perf optimisation #1 — HTTP/2 keep-alive for connector-service.
 *
 * Returns the `createConnectTransport` options the factory will use. Exposed
 * as a pure function so tests can assert the wire settings (httpVersion=2,
 * keep-alive ping cadence) without poking at the Transport opaque type.
 *
 * Why HTTP/2:
 * - Cloud Run fronts both tenant-runtime and connector-service with ALB/Envoy
 *   that negotiates HTTP/2 end-to-end.
 * - @connectrpc/connect-node's built-in Http2SessionManager keeps the session
 *   alive between RPCs within a process lifetime (no TCP+TLS handshake per
 *   call), multiplexes N concurrent RPCs over a single session, and pings on
 *   idle so the remote doesn't half-close the connection.
 * - Together with the module-scoped `sharedClient` singleton, this reuses
 *   TCP/TLS state across every connector-service RPC the tenant-runtime
 *   process issues, which is what the p95 < 20ms target relies on.
 *
 * We prefer the native connect-node HTTP/2 path over wiring undici separately
 * because connect-node owns the full request lifecycle for this transport and
 * any undici Pool would be ignored by the Connect protocol layer.
 */
export function buildTransportOptions(baseUrl: string, interceptors: Interceptor[]) {
  return {
    baseUrl,
    httpVersion: '2' as const,
    interceptors,
    // `pingIdleConnection: true` races with HTTP/2 session teardown and throws
    // ERR_HTTP2_INVALID_SESSION from the ping timer after the session closes
    // (connectrpc/connect-es#1143). That crashed tenant-runtime prod via our
    // uncaughtException handler. Keep the ping cadence for active sessions
    // but don't ping when idle — connect-node rebuilds the session on the
    // next RPC, so the keep-alive win is marginal vs. the crash risk.
    pingIntervalMs: 30_000,
    pingIdleConnection: false,
    pingTimeoutMs: 5_000,
    // Drop truly idle sessions after 10 minutes so we don't hold a dead
    // connection across long quiet stretches.
    idleConnectionTimeoutMs: 10 * 60 * 1000,
  };
}

export function createConnectorServiceClient(
  opts: ConnectorServiceClientOptions = {},
): Client<typeof ConnectorService> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const interceptors: Interceptor[] = [
    defaultAuthInterceptor(baseUrl),
    ...(opts.extraInterceptors ?? []),
  ];
  const transport = createConnectTransport(buildTransportOptions(baseUrl, interceptors));
  return createClient(ConnectorService, transport);
}

export function getConnectorServiceClient(): Client<typeof ConnectorService> {
  if (!sharedClient) sharedClient = createConnectorServiceClient();
  return sharedClient;
}

export function resetSharedConnectorServiceClient(): void {
  sharedClient = null;
}

// PrefetchThread types — forward declarations matching the proto definition in
// @liftoffos/proto-gen v0.5.5. These will be replaced by direct proto-gen
// imports once that version is deployed as a dependency update.
export interface PrefetchThreadRequest {
  tenantContext?: { tenantId: string };
  connectorId: string;
  entityType: string;
  entityId: string;
  traceId: string;
}

export interface PrefetchThreadResponse {
  success: boolean;
  content: string;
  error: string;
}

export type PrefetchCapableClient = {
  prefetchThread(req: PrefetchThreadRequest): Promise<PrefetchThreadResponse>;
};

// Returns the shared connector-service client cast to include the PrefetchThread
// RPC, which is defined in proto-gen v0.5.5 and available on the server side.
export function getPrefetchThreadClient(): PrefetchCapableClient {
  return getConnectorServiceClient() as unknown as PrefetchCapableClient;
}
