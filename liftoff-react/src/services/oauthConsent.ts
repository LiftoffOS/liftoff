// MCP OAuth consent API client (plan v6.1 Phase 3)
//
// Typed wrappers for the backend consent pair behind /oauth/consent.
// Uses the shared api helper (Firebase-authed) per the service-layer rule.

import { api } from './api'

export interface OauthConsentRequest {
  clientName: string
  /** Which tool the client is, from the name it registered under; null for a
   *  client the backend does not know. Optional so a platform-backend that
   *  predates the pair still renders the page. */
  clientSlug?: string | null
  clientLabel?: string
  redirectHost: string
  scope: string
  expiresAt: string
}

export interface OauthConsentDecision {
  redirectTo: string
}

export async function getOauthConsentRequest(requestId: string): Promise<OauthConsentRequest> {
  return api.get<OauthConsentRequest>(`/api/oauth/consent/${encodeURIComponent(requestId)}`)
}

export interface OauthConsentParked {
  parked: boolean
  onboardingUrl: string
}

/** Park a request for an owner whose workspace has not finished onboarding:
 *  the same request approves when they return from /onboarding. */
export async function parkOauthConsent(input: { requestId: string; tenantId: string }): Promise<OauthConsentParked> {
  return api.post<OauthConsentParked>('/api/oauth/consent/park', input)
}

export async function submitOauthConsent(input: {
  requestId: string
  tenantId?: string
  approve: boolean
}): Promise<OauthConsentDecision> {
  return api.post<OauthConsentDecision>('/api/oauth/consent', input)
}

// ── Device flow (RFC 8628): the /activate page ──────────────────────────
//
// A tool that cannot reach a browser on its own machine shows the person a
// code and sends them to /activate. The page looks the code up, shows the
// same consent as /oauth/consent, and approves against the code: the tool
// is polling the token endpoint and collects its tokens when the code is
// approved, so nothing is redirected anywhere. A code is never parked for
// onboarding: the tool stops polling after the 10 minutes it was told.

export interface DeviceCodeLookup {
  clientName: string
  clientSlug?: string | null
  clientLabel?: string
  expiresAt: string
}

export async function lookupDeviceCode(userCode: string): Promise<DeviceCodeLookup> {
  return api.post<DeviceCodeLookup>('/api/oauth/device/lookup', { userCode })
}

export async function submitDeviceDecision(input: {
  userCode: string
  tenantId?: string
  approve: boolean
}): Promise<{ approved: boolean; workspaceName?: string }> {
  return api.post<{ approved: boolean; workspaceName?: string }>('/api/oauth/device', input)
}

