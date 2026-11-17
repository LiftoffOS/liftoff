// Which grants a client is registered for, negotiated at registration (RFC
// 7591 §2: the server may replace the requested set with the one it grants)
// and read back wherever a grant is exercised.
//
// The negotiated list is what gets persisted in oauth_clients.grant_types and
// echoed in the registration response, so the three never disagree. A client
// that asks for nothing gets the pair every client got before the device
// grant existed, so older registrations and the clients that made them are
// unchanged.

export const AUTHORIZATION_CODE_GRANT = 'authorization_code';
export const REFRESH_TOKEN_GRANT = 'refresh_token';
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export const SUPPORTED_GRANT_TYPES = [AUTHORIZATION_CODE_GRANT, REFRESH_TOKEN_GRANT, DEVICE_CODE_GRANT] as const;
const DEFAULT_GRANT_TYPES = [AUTHORIZATION_CODE_GRANT, REFRESH_TOKEN_GRANT];

/** The grants this registration ends up with, or null when nothing the
 *  client asked for is one we serve. */
export function negotiateGrantTypes(requested: string[] | undefined): string[] | null {
  if (!requested || requested.length === 0) return [...DEFAULT_GRANT_TYPES];
  const granted = SUPPORTED_GRANT_TYPES.filter((g) => requested.includes(g));
  return granted.length > 0 ? [...granted] : null;
}

export function usesDeviceGrant(grantTypes: readonly string[]): boolean {
  return grantTypes.includes(DEVICE_CODE_GRANT);
}

/** The response types that go with a set of grants: `code` is the
 *  authorization code grant's, and nothing else here has one. */
export function responseTypesFor(grantTypes: readonly string[]): string[] {
  return grantTypes.includes(AUTHORIZATION_CODE_GRANT) ? ['code'] : [];
}

/** Read the persisted list, tolerating the JSONB shapes pg hands back. */
export function parseGrantTypes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}
