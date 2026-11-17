// The platform's prepaid balances at the aggregators connector-service pays
// on its behalf (Locus, Vaaya), read from that service's internal route —
// the keys live there. Each figure is a number or null with the reason, and
// an unreachable service answers nulls with the reason, never a guess.

import { buildOidcAuthHeader } from '@liftoffos/service-client';

export interface PlatformVendorBalance { usd: number | null; error?: string }
export interface PlatformVendorBalances { locus: PlatformVendorBalance; vaaya: PlatformVendorBalance }

export async function fetchPlatformVendorBalances(): Promise<PlatformVendorBalances> {
  const base = process.env.CONNECTOR_SERVICE_URL;
  const unavailable = (error: string): PlatformVendorBalances => ({ locus: { usd: null, error }, vaaya: { usd: null, error } });
  if (!base) return unavailable('CONNECTOR_SERVICE_URL is not set');
  const headers: Record<string, string> = {};
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;
  try {
    Object.assign(headers, await buildOidcAuthHeader(base));
  } catch {
    // Local development without an identity token; the service token alone
    // is what the route checks.
  }
  try {
    const resp = await fetch(`${base}/api/connectors/platform-vendors/balances`, { headers });
    if (!resp.ok) return unavailable(`connector-service answered HTTP ${resp.status}`);
    const body = (await resp.json()) as Partial<PlatformVendorBalances>;
    const one = (b: PlatformVendorBalance | undefined): PlatformVendorBalance =>
      b && typeof b.usd === 'number' && Number.isFinite(b.usd) ? { usd: b.usd } : { usd: null, error: b?.error ?? 'no figure in the answer' };
    return { locus: one(body.locus), vaaya: one(body.vaaya) };
  } catch (err) {
    return unavailable((err as Error).message);
  }
}
