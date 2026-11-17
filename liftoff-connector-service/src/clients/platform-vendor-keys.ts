// Platform credentials for internal-tier data vendors.
//
// These vendors are platform-funded by default: a workspace needs no vendor
// account for them, so an execute may arrive with no tenant credential at
// all. The executor then pays with the platform key from the environment.
// One map, used by both the executors (fallback resolution) and the
// dispatcher's internal-instance branch (so the key joins the secret-scrub
// set and can never echo back in a vendor response).
//
// An absent value means the vendor is not yet provisioned; the executor
// refuses with a typed failure rather than half-configuring itself.

export const PLATFORM_VENDOR_KEY_ENV: Record<string, string> = {
  tikhub: 'TIKHUB_PLATFORM_API_KEY',
  strale: 'STRALE_PLATFORM_API_KEY',
  hunterio: 'HUNTER_PLATFORM_API_KEY',
  pdl: 'PDL_PLATFORM_API_KEY',
  // saperly is NOT here: telephony is BYO-key only (identity-bound 10DLC), a
  // user-visible connector card — there is no platform Saperly credential.
  // nasdaq is not here: it now reads nasdaq.com's KEYLESS public web API. The
  // old NASDAQ_PLATFORM_API_KEY was for the retired Data Link dataset API.
};

export function resolvePlatformVendorKey(connectorType: string): string | undefined {
  const envVar = PLATFORM_VENDOR_KEY_ENV[connectorType];
  const value = envVar ? process.env[envVar] : undefined;
  return value && value.trim() ? value : undefined;
}

/** The workspace's OWN credential for this call, or undefined when there is
 *  none. On the `internal:<type>` path the dispatcher rides the PLATFORM key
 *  inside ctx.credentials so it joins the secret-scrub set — which means a
 *  bare truthiness test on credentials.apiKey reads platform funding as the
 *  tenant's. Only a real connector instance can carry a tenant credential,
 *  so anything arriving on the internal identity is not the tenant's key.
 *  Funding stamps and BYO-lane routing must go through this, never through
 *  credentials.apiKey directly. */
export function tenantOwnApiKey(ctx: {
  connectorId: string;
  credentials: { apiKey?: string };
}): string | undefined {
  if (ctx.connectorId.startsWith('internal:')) return undefined;
  const key = ctx.credentials.apiKey?.trim();
  return key || undefined;
}
