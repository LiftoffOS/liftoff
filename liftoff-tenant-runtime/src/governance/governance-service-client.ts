// Governance Service Client (Connect-RPC) — tenant-runtime side.
//
// Mirror of src/connectors/connector-service-client.ts. Thin wrapper over
// @connectrpc/connect's `createClient` targeting the proto-defined
// GovernanceService. Used by tool-gateway under shadow/on modes.
//
// Hot path pattern (see proto docs):
//   1. Once per invocation:  Preflight     → cached 30s with push invalidation
//   2. Per tool call:        Authorize     → synchronous, p99 < 5ms
//   3. After tool call:      Record        → fire-and-forget 202 Accepted
//
// Fail-closed: if this service is unreachable in 'on' mode, the shadow-mode
// helper re-throws rather than falling back to legacy — governance is a
// safety system and the legacy code path is stripped post-cutover.

import {
  createClient,
  ConnectError,
  Code,
  type Interceptor,
  type Client,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { GovernanceService } from '@liftoffos/proto-gen';
import * as governanceServiceNs from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb.js';
import * as governanceTypesNs from '@liftoffos/proto-gen/dist/liftoff/governance/v1/types_pb.js';
import { getManagedSecret } from '../infrastructure/secret-store';

// ── Re-export proto types so callers don't need deep imports ─────────────

export { ConnectError, Code, GovernanceService };

export type PreflightRequest = governanceServiceNs.PreflightRequest;
export type PreflightResponse = governanceServiceNs.PreflightResponse;
export type AuthorizeRequest = governanceServiceNs.AuthorizeRequest;
export type AuthorizeResponse = governanceServiceNs.AuthorizeResponse;
export type RecordRequest = governanceServiceNs.RecordRequest;
export type RecordResponse = governanceServiceNs.RecordResponse;
export type ListApprovalsRequest = governanceServiceNs.ListApprovalsRequest;
export type ListApprovalsResponse = governanceServiceNs.ListApprovalsResponse;
export const AuthorizeDecision = governanceServiceNs.AuthorizeDecision;
export const AdmissionStatus = governanceTypesNs.AdmissionStatus;
export const AdmissionReason = governanceTypesNs.AdmissionReason;
export const ActionStatus = governanceTypesNs.ActionStatus;

// ── Client factory ──────────────────────────────────────────────────────

export interface GovernanceServiceClientOptions {
  baseUrl?: string;
  extraInterceptors?: Interceptor[];
}

function resolveBaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.GOVERNANCE_SERVICE_URL;
  if (!url) {
    throw new Error('GOVERNANCE_SERVICE_URL is not set (or pass options.baseUrl)');
  }
  return url;
}

function defaultAuthInterceptor(baseUrl: string): Interceptor {
  return (next) => async (req) => {
    const token = getManagedSecret('GOVERNANCE_SERVICE_TOKEN');
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

let sharedClient: Client<typeof GovernanceService> | null = null;

/**
 * HTTP/2 keep-alive + pooling settings — matches connector-service client.
 *
 * Why HTTP/2:
 * - Cloud Run fronts both tenant-runtime and governance-engine with ALB/Envoy
 *   that negotiates HTTP/2 end-to-end.
 * - @connectrpc/connect-node's Http2SessionManager keeps the session alive
 *   between RPCs (no TCP+TLS handshake per call), multiplexes concurrent
 *   RPCs over a single session, and pings on idle so the remote doesn't
 *   half-close the connection.
 * - Together with the module-scoped `sharedClient` singleton, this reuses
 *   TCP/TLS state across every governance-engine RPC the tenant-runtime
 *   process issues, which is what the Authorize p99 < 5ms target requires.
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

export function createGovernanceServiceClient(
  opts: GovernanceServiceClientOptions = {},
): Client<typeof GovernanceService> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const interceptors: Interceptor[] = [
    defaultAuthInterceptor(baseUrl),
    ...(opts.extraInterceptors ?? []),
  ];
  const transport = createConnectTransport(buildTransportOptions(baseUrl, interceptors));
  return createClient(GovernanceService, transport);
}

export function getGovernanceServiceClient(): Client<typeof GovernanceService> {
  if (!sharedClient) sharedClient = createGovernanceServiceClient();
  return sharedClient;
}

export function resetSharedGovernanceServiceClient(): void {
  sharedClient = null;
}

// ── REST helpers for governance-engine approval policies ─────────────────────

function resolveGovernanceBaseUrl(): string {
  const url = process.env.GOVERNANCE_SERVICE_URL;
  if (!url) throw new Error('GOVERNANCE_SERVICE_URL is not set');
  // GOVERNANCE_SERVICE_URL may be the Connect-RPC base URL with path segment —
  // strip any trailing path so we target the Express REST router correctly.
  return url.replace(/\/grpc\/?$/, '').replace(/\/+$/, '');
}

async function governanceAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getManagedSecret('GOVERNANCE_SERVICE_TOKEN');
  if (token) headers['X-Service-Auth'] = token;
  try {
    const oidc = await buildOidcAuthHeader(baseUrl);
    for (const [k, v] of Object.entries(oidc)) headers[k] = v;
  } catch {
    // OIDC fetch silently skips in local dev (no metadata server).
  }
  return headers;
}

export interface GovernanceApprovalPolicy {
  id: string;
  tenantId: string;
  agentId: string;
  gateReason: string;
  decision: 'approved' | 'rejected';
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  /** Class-scoped grant. null/absent = a reason-wide policy (does NOT clear the
   *  external_content_write gate); a non-null array clears only calls whose bare
   *  action name is in the set. */
  actionClasses?: string[] | null;
}

/** The standing policy for one reason, or null when there is none.
 *
 *  Two callers, two failure postures. The gate reads fail-OPEN: a lookup that
 *  cannot complete is "no standing policy", and the gate fires normally — a
 *  person is asked, which is the safe side for a decision about whether to
 *  ask. The consumption point reads STRICT: it is recomputing what a yes
 *  covered, and "no policy" there means a reason the grant may not cover, so
 *  an outage read as "no policy" re-asks about a change nobody made. Under
 *  `strict` a read that cannot complete throws; the caller turns that into a
 *  deferral. A 404 is an answer in both postures (there is no policy), and so
 *  is a deployment with no governance service configured. */
export async function getGovernanceApprovalPolicy(
  tenantId: string,
  agentId: string,
  gateReason: string,
  opts: { strict?: boolean } = {},
): Promise<GovernanceApprovalPolicy | null> {
  if (!process.env.GOVERNANCE_SERVICE_URL) return null;
  try {
    const base = resolveGovernanceBaseUrl();
    const headers = await governanceAuthHeaders(base);
    const url = `${base}/api/governance/approvals/approval-policies?tenantId=${encodeURIComponent(tenantId)}&agentId=${encodeURIComponent(agentId)}&gateReason=${encodeURIComponent(gateReason)}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      if (opts.strict) throw new Error(`governance answered ${resp.status}`);
      return null; // fail-open: gate fires normally if lookup fails
    }
    return (await resp.json()) as GovernanceApprovalPolicy;
  } catch (err) {
    if (opts.strict) throw err;
    return null; // fail-open
  }
}

export interface AgentActionTrust {
  tier: string; // 'watch' | 'queue' | 'auto'
  runs: number;
  passRate: number;
}

/**
 * SHADOW-MODE trust lookup — mirrors getGovernanceApprovalPolicy exactly (same
 * auth header, same 5s timeout, same fail-safe semantics). Consulted ONLY by the
 * runtime HITL gate's shadow evaluation to LOG what a per-(agent, action) trust
 * ledger WOULD decide; it never changes a gate decision.
 *
 * Fail-safe: ANY error (network, non-200, 404, or the endpoint simply not being
 * deployed yet in this env) resolves to `null`, never throws. The gate treats
 * `null` as "no trust signal" and behaves exactly as it does today.
 */
export async function getAgentActionTrust(
  tenantId: string,
  agentId: string,
  actionClass: string,
): Promise<AgentActionTrust | null> {
  try {
    const base = resolveGovernanceBaseUrl();
    const headers = await governanceAuthHeaders(base);
    const url = `${base}/api/governance/action-trust?tenantId=${encodeURIComponent(tenantId)}&agentId=${encodeURIComponent(agentId)}&actionClass=${encodeURIComponent(actionClass)}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (resp.status === 404) return null;
    if (!resp.ok) return null; // fail-safe: no trust signal → gate behaves as today
    return (await resp.json()) as AgentActionTrust;
  } catch {
    return null; // fail-safe
  }
}

export async function createGovernanceApprovalPolicy(input: {
  tenantId: string;
  agentId: string;
  gateReason: string;
  decision: 'approved' | 'rejected';
  createdBy: string;
  expiresAt?: string;
  /** When set, the policy is class-scoped — only calls whose bare action name is
   *  in this set are cleared (required for external_content_write grants). */
  actionClasses?: string[] | null;
}): Promise<void> {
  const base = resolveGovernanceBaseUrl();
  const headers = await governanceAuthHeaders(base);
  const resp = await fetch(`${base}/api/governance/approvals/approval-policies`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`createGovernanceApprovalPolicy failed: ${resp.status}`);
  }
}

export async function postActionTrustDecisions(input: {
  tenantId: string;
  agentId: string;
  gateReason: string;
  approvalId: string; // source identity travels with the payload
  decisions: Array<{
    actionClass: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedAt: string;
    sourceKey: string; // '<approvalId>:<actionClass>'
  }>;
}): Promise<void> {
  const base = resolveGovernanceBaseUrl();
  const headers = await governanceAuthHeaders(base);
  const resp = await fetch(`${base}/api/governance/action-trust/decisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`postActionTrustDecisions failed: ${resp.status}`);
  }
}

export async function deleteGovernanceApprovalPolicy(
  tenantId: string,
  agentId: string,
  gateReason: string,
): Promise<void> {
  const base = resolveGovernanceBaseUrl();
  const headers = await governanceAuthHeaders(base);
  const resp = await fetch(`${base}/api/governance/approvals/approval-policies`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ tenantId, agentId, gateReason }),
    signal: AbortSignal.timeout(5000),
  });
  // 404 = policy already absent; treat as success (idempotent revoke).
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`deleteGovernanceApprovalPolicy failed: ${resp.status}`);
  }
}
