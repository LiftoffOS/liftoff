// The capture page's API client.
//
// A capture link is how a custom API connection gets its credential without the
// value ever entering a conversation: the page reads what the connection is,
// the person enters the key, and it is posted to platform-backend, which hands
// it to connector-service, which writes Secret Manager. Nothing here stores it
// and nothing here reads one back — a capture token holds no value.

import { api } from './api'

export interface CustomApiCaptureView {
  provider: string
  purpose: string
  apiHosts: string[]
  /** What the person is being asked for, as a field label. */
  credentialLabel: string
  /** Where the value will be sent, in one line. */
  placementSummary: string
  /** How it will be checked before the connection is switched on. */
  verificationSummary: string
  expiresAt: string
  /** True once this link has been spent. The page says so rather than taking a
   *  key it will refuse. */
  spent: boolean
  /** True when this link replaces the key on a connection that already exists,
   *  keeping its id so every bound agent recovers at once. */
  reconnect: boolean
}

export interface CustomApiCaptureResult {
  kind: 'connected'
  connectorId: string
  status: 'active' | 'error'
  operationCount: number
  externalAccountLabel?: string
  verification?: { ok: boolean; layer?: string; message?: string; httpStatus?: number }
}

export async function readCustomApiCapture(
  token: string,
  tenantId: string,
): Promise<CustomApiCaptureView> {
  return api.get<CustomApiCaptureView>(
    `/api/custom-api-connectors/capture/${encodeURIComponent(token)}?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

export async function submitCustomApiCapture(input: {
  token: string
  tenantId: string
  credential: string
}): Promise<CustomApiCaptureResult> {
  return api.post<CustomApiCaptureResult>(
    `/api/custom-api-connectors/capture/${encodeURIComponent(input.token)}`,
    { tenantId: input.tenantId, credential: input.credential },
  )
}

// ── Repair and removal ───────────────────────────────────────────────────
//
// Three of the four controls a custom API connection has; the fourth —
// removing the connection — is the ordinary connector delete the Connections
// page already performs. None of them implies another, which is why they are
// three calls rather than one.

export interface CustomApiConnection {
  connectorId: string
  name: string
  providerSlug: string
  baseUrl: string
  apiHosts: string[]
  auth: { scheme: string; name?: string; prefix?: string }
  verification: { method: string; path: string; accountIdentityField?: string }
  operationCount: number
  /** The operation names, listed the way a custom MCP server's tools are. */
  operations: string[]
  /** The provider's specification is no longer the one this connection was
   *  built from. Rediscover Endpoints is what acts on it. */
  specDrifted: boolean
  specDriftCheckedAt: string | null
  specSourceUrl: string | null
  specHash: string
  specFetchedAt: string | null
  /** Null until the declared verification call has actually succeeded, so
   *  "connected" can never be read as "verified" off this row. */
  verifiedAt: string | null
  completedByAccountId: string | null
  updatedAt: string
  version: string
}

export interface CustomApiVerificationOutcome {
  ok: boolean
  /** Which layer answered: authentication, permission, endpoint, rate_limit,
   *  blocked_host, unreachable. A 401 is not proof the key is wrong. */
  layer?: string
  message?: string
  httpStatus?: number
}

export async function getCustomApiConnection(
  connectorId: string,
  tenantId: string,
): Promise<CustomApiConnection> {
  return api.get<CustomApiConnection>(
    `/api/custom-api-connectors/connections/${encodeURIComponent(connectorId)}?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

export interface CustomApiConnectionChanges {
  name?: string
  baseUrl?: string
  apiHosts?: string[]
  auth?: { scheme: string; name?: string; prefix?: string }
  verification?: { method: 'GET' | 'HEAD'; path: string; accountIdentityField?: string }
}

/** Edit the description in place, keeping the connector id every bound agent
 *  holds, and prove the result. Never asks for the key again. */
export async function updateCustomApiConnection(input: {
  connectorId: string
  tenantId: string
  changes: CustomApiConnectionChanges
}): Promise<{ connection: CustomApiConnection; verification: CustomApiVerificationOutcome }> {
  return api.patch<{ connection: CustomApiConnection; verification: CustomApiVerificationOutcome }>(
    `/api/custom-api-connectors/connections/${encodeURIComponent(input.connectorId)}`,
    { tenantId: input.tenantId, ...input.changes },
  )
}

/** Re-run the declared verification with the key already in custody. */
export async function reverifyCustomApiConnection(input: {
  connectorId: string
  tenantId: string
}): Promise<CustomApiVerificationOutcome> {
  return api.post<CustomApiVerificationOutcome>(
    `/api/custom-api-connectors/connections/${encodeURIComponent(input.connectorId)}/verify`,
    { tenantId: input.tenantId },
  )
}

export interface CustomApiSpecRefresh {
  changed: boolean
  applied: boolean
  specHash: string
  previousSpecHash: string
  /** Operations the provider has added, and ones it no longer offers. */
  added: string[]
  removed: string[]
  operationCount: number
}

/** Read the provider's specification again. Without `apply` it reports what
 *  changed and writes nothing: applying can remove an operation, and an AI
 *  team bound to it loses it. */
export async function refreshCustomApiSpec(input: {
  connectorId: string
  tenantId: string
  apply?: boolean
}): Promise<CustomApiSpecRefresh> {
  return api.post<CustomApiSpecRefresh>(
    `/api/custom-api-connectors/connections/${encodeURIComponent(input.connectorId)}/spec-refresh`,
    { tenantId: input.tenantId, apply: input.apply === true },
  )
}
