// Which credential a capability call runs on — one rule, read by both ends.
//
// Execution picks the credential: the workspace's own connected connector of
// the vendor's type when there is one, else the platform key (`internal:<type>`)
// where the platform holds one. Search has to make the SAME choice, because a
// credential that failed at account level is parked by credential (vendor-
// gate.ts), and a search that judged "is this vendor usable for this caller"
// against a different credential than the run would then use is a search
// that offers what the run will refuse, or hides what it would have run.
//
// So the rule lives here, once. `selectConnectedConnector` is the choice;
// `credentialRefFor` is the key the cooldown table is written and read under;
// `resolveCredentialMap` is the one lookup a search makes for a caller, and
// the executor re-resolves per call because a handle can outlive a connection
// change (the handle lives thirty minutes; a connector can be disconnected in
// between).
//
// Apify is always the platform credential: `runApifyActor` reads
// APIFY_PLATFORM_TOKEN and has no tenant-key execution path, so a workspace's
// own Apify binding does not change which key a store actor runs on and must
// not change which key its cooldown is read under.

import { listConnectorsForTenant } from '../connectors/connector-service-client';
import { log } from '../infrastructure/logging';

export interface ConnectorRow {
  id: string;
  type?: string;
  status?: string;
}

/** A connector row counts as a live credential only when positively connected.
 *  Placeholder / reconnect-required rows are not. The exact status vocabulary
 *  connector-service emits should be re-confirmed when the first BYO vendor
 *  path is exercised; until then this is deliberately conservative (an
 *  unrecognized status degrades to the platform path, never a wrong charge). */
export function isConnectedStatus(status: string | undefined): boolean {
  return status === 'connected' || status === 'active';
}

/** The workspace's own connector this vendor type would run on: the FIRST
 *  positively connected row of that type, in the order the service lists
 *  them, or null when there is none. */
export function selectConnectedConnector(rows: ConnectorRow[], connectorType: string): ConnectorRow | null {
  return rows.find((c) => c.type === connectorType && isConnectedStatus(c.status)) ?? null;
}

/** Vendors with platform rungs BEHIND the workspace's own key: a call tries
 *  the connected key first and, when that credential is parked, still has
 *  the platform's own way of running (for apify: the x402 prepaid token,
 *  then the platform account). Every other vendor with a connected key runs
 *  on that key alone. */
const RUNG_FALLBACK_VENDORS = new Set(['apify']);

/** The cooldown key for a credential: the connector id actually dispatched
 *  on, or the platform key of the type. */
export function credentialRefFor(connectorType: string, connectorId: string | null): string {
  if (!connectorId) return `internal:${connectorType}`;
  return `connector:${connectorId}`;
}

/** Whether a call for this vendor has NO usable credential right now: the
 *  one it would dispatch on is parked and, for a vendor with platform rungs
 *  behind the workspace's key, so is the platform's. Search hides what this
 *  says is unusable; execution refuses it. */
export function credentialCooling(
  connectorType: string,
  resolved: ResolvedCredential,
  isCooling: (credentialRef: string) => boolean,
): boolean {
  if (!isCooling(resolved.credentialRef)) return false;
  if (RUNG_FALLBACK_VENDORS.has(connectorType) && resolved.connectorId) {
    return isCooling(credentialRefFor(connectorType, null));
  }
  return true;
}

export interface ResolvedCredential {
  /** The workspace connector the call would run on, or null for the platform key. */
  connectorId: string | null;
  credentialRef: string;
}

export type CredentialResolver = (connectorType: string) => ResolvedCredential;

/** Every vendor resolves to the platform key: the answer when no account is
 *  in hand (an autonomous run, a caller with no person behind it), and the
 *  fail-soft answer when the connector lookup could not be made. Exact for the
 *  hidden platform vendors, which are never user-connectable; a documented
 *  degradation for a workspace's own key, which is then judged against the
 *  platform credential's state until the next search. */
export const platformOnlyCredentials: CredentialResolver = (connectorType) => ({
  connectorId: null,
  credentialRef: credentialRefFor(connectorType, null),
});

/** The credential each vendor type would run on for this caller, resolved
 *  from ONE connector listing. A lookup failure keeps the platform fallback
 *  execution uses and says so, because a search made on the wrong credential
 *  scope is degraded even when it looks complete. */
export async function resolveCredentialMap(tenantId: string, accountId: string | undefined): Promise<CredentialResolver> {
  if (!accountId) return platformOnlyCredentials;
  let rows: ConnectorRow[];
  try {
    rows = await listConnectorsForTenant(tenantId, accountId);
  } catch (err) {
    log.warn(
      { err: (err as Error).message, tenantId },
      'capability search: connector lookup failed; judging vendors on the platform credential (search may be degraded)',
    );
    return platformOnlyCredentials;
  }
  return (connectorType) => {
    const connectorId = selectConnectedConnector(rows, connectorType)?.id ?? null;
    return { connectorId, credentialRef: credentialRefFor(connectorType, connectorId) };
  };
}
