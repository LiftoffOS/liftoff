// The operator's switch for a platform-provided vendor, and the short memory
// of a credential that failed at account level.
//
// Two different answers to two different questions, read from one cache:
//
// THE SWITCH. A platform vendor is offered to the model whenever its key
// exists, and a key says nothing about whether the account behind it can pay:
// the platform Apify account runs on a fixed credit with no auto-reload, and a
// vendor whose credit is gone still gets picked, fails at the vendor, and
// hands the model a no-result after a wasted turn — with nothing for an
// operator to flip except deleting the key, which is the one thing nobody
// wants to do twice. The admin API has had a connector kill switch for a long
// time (`POST /api/admin/kill-switch/connector/:type/disable`, the
// `disabled_connectors` table); this module is its reader for the capability
// path: a switched-off vendor is not OFFERED (capability search, the
// distiller's prior art) and does not RUN (the vendor executor). A deliberate,
// indefinite stop, set and cleared by a person.
//
// THE COOLDOWN. A credential that just answered 401 (the wire classified it
// an expired credential) or an explicit payment-required response is parked
// for a few minutes (`vendor_cooldowns`, migration 479), keyed by the
// credential that failed — `internal:<type>` for the platform key, which is
// shared by every workspace and so is dead for every workspace at that
// moment, or `connector:<id>` for a workspace's own connector, which is dead
// for that workspace only. Written by the executor at the failure; read by
// search (a cooling vendor's candidates are not offered) and by the executor
// (a cooling credential is skipped before dispatch). Self-clearing: the row's
// own expiry decides, on every read, so a stale cache during a database
// blip still lets a park lapse on time, and never a switch to be flipped.
//
// The two are never conflated: the switch is a set of connector types, the
// cooldown a map of credentials to expiries, and a caller asks for the one it
// means.
//
// Read through a short cache because the offer step consults it once per
// search and the executor once per call. A read that fails keeps the last
// known state: the switch is an OFF an operator sets deliberately, and a
// database blip must not turn every vendor off — or, once it has been set,
// back on. A local park is applied to the cache at once and survives a
// refresh that was already in flight when it landed, so the same instance's
// next call sees it; other instances see it within the cache window.

import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const CACHE_TTL_MS = 30_000;

export type CooldownReason = 'auth' | 'payment';

interface GateCache {
  readAt: number;
  off: Set<string>;
  /** credential_ref → expiry (epoch ms), live rows only at the time of the read. */
  cooling: Map<string, number>;
}

let cache: GateCache | null = null;

/** Parks this process wrote, by credential, so a refresh that read the table
 *  before the row landed cannot replace a newer local park with an older or
 *  absent one. Pruned as they expire. */
const localParks = new Map<string, number>();

function applyLocalParks(cooling: Map<string, number>, now: number): void {
  for (const [ref, expiresAt] of localParks) {
    if (expiresAt <= now) {
      localParks.delete(ref);
      continue;
    }
    const known = cooling.get(ref);
    if (known === undefined || known < expiresAt) cooling.set(ref, expiresAt);
  }
}

/** Refresh the switch set and the live cooldown rows, at most once per
 *  CACHE_TTL_MS. Every caller on the capability path reaches this once per
 *  request; the synchronous readers below answer from what it loaded. */
async function refresh(): Promise<GateCache> {
  const now = Date.now();
  if (cache && now - cache.readAt < CACHE_TTL_MS) return cache;
  let off: Set<string>;
  try {
    const result = await getPool().query<{ connector_type: string }>(
      'SELECT connector_type FROM disabled_connectors',
    );
    off = new Set(result.rows.map((r) => r.connector_type));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'vendor gate: disabled_connectors read failed; keeping the last known set');
    off = cache?.off ?? new Set();
  }
  let cooling: Map<string, number>;
  try {
    // RLS_RAW_POOL_OK: vendor_cooldowns is platform-scoped, keyed by the
    // credential; there is no tenant scope to set.
    const result = await getPool().query<{ credential_ref: string; expires_at: Date | string }>(
      'SELECT credential_ref, expires_at FROM vendor_cooldowns WHERE expires_at > now()',
    );
    cooling = new Map(result.rows.map((r) => [r.credential_ref, new Date(r.expires_at).getTime()]));
  } catch (err) {
    // The last known rows stand; each still expires by its own timestamp on
    // read (isCooling), so a failed refresh never extends a park.
    log.warn({ err: (err as Error).message }, 'vendor gate: vendor_cooldowns read failed; keeping the last known rows');
    cooling = new Map(cache?.cooling ?? []);
  }
  applyLocalParks(cooling, Date.now());
  cache = { readAt: Date.now(), off, cooling };
  return cache;
}

/** The set of switched-off connector types, refreshed at most once per
 *  CACHE_TTL_MS. Refreshing here also loads the live cooldowns, so one call
 *  per request serves both readers. */
export async function switchedOffVendors(): Promise<Set<string>> {
  return (await refresh()).off;
}

/** Whether the operator has switched this vendor off. */
export async function platformVendorSwitchedOff(connectorType: string): Promise<boolean> {
  return (await switchedOffVendors()).has(connectorType);
}

/** The cached answer, for the one synchronous reader (the distiller's
 *  prior-art rendering, which runs after discovery has already refreshed the
 *  cache in the same request). Before any read: nothing is off. */
export function platformVendorSwitchedOffSync(connectorType: string): boolean {
  return cache?.off.has(connectorType) ?? false;
}

/** Whether this credential is parked RIGHT NOW. The expiry is tested on every
 *  read, never only at refresh: a cache kept past its window by a failed
 *  refresh still lets every row lapse on time. Answered from the cache, which
 *  the request's earlier refresh (switchedOffVendors / the executor's switch
 *  check) has loaded; before any read, nothing is cooling. */
export function isCooling(credentialRef: string): boolean {
  const expiresAt = cache?.cooling.get(credentialRef) ?? localParks.get(credentialRef);
  return expiresAt !== undefined && expiresAt > Date.now();
}

export interface ParkCredentialInput {
  credentialRef: string;
  connectorType: string;
  /** Attribution for an operator reading the table; null for the platform key. */
  tenantId: string | null;
  reason: CooldownReason;
  /** How long from now the park lasts. */
  durationMs: number;
}

/** Park a credential: this process at once, the table for every other
 *  instance. The local cache is updated FIRST so the same instance's next call
 *  sees the park whatever the database does; the row is an upsert on the
 *  credential, so a repeat park refreshes the expiry. A write failure is
 *  logged and never fails the call that discovered the failure. */
export async function parkCredential(input: ParkCredentialInput): Promise<void> {
  const expiresAt = Date.now() + input.durationMs;
  localParks.set(input.credentialRef, expiresAt);
  if (cache) {
    const known = cache.cooling.get(input.credentialRef);
    if (known === undefined || known < expiresAt) cache.cooling.set(input.credentialRef, expiresAt);
  }
  try {
    // RLS_RAW_POOL_OK: vendor_cooldowns is platform-scoped, keyed by the
    // credential; tenant_id is attribution, not a scope.
    await getPool().query(
      `INSERT INTO vendor_cooldowns (credential_ref, connector_type, tenant_id, reason, expires_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
       ON CONFLICT (credential_ref) DO UPDATE
         SET connector_type = EXCLUDED.connector_type,
             tenant_id = EXCLUDED.tenant_id,
             reason = EXCLUDED.reason,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [input.credentialRef, input.connectorType, input.tenantId, input.reason, expiresAt],
    );
    log.info(
      {
        event: 'vendor_credential_parked',
        credentialRef: input.credentialRef,
        connectorType: input.connectorType,
        scope: input.tenantId ? 'workspace' : 'platform',
        reason: input.reason,
        expiresAt: new Date(expiresAt).toISOString(),
      },
      'vendor gate: credential parked after an account-level failure',
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, credentialRef: input.credentialRef, reason: input.reason },
      'vendor gate: vendor_cooldowns write failed; the park holds on this instance only',
    );
  }
}

export interface OperatorCooldownView {
  /** The platform key's parks, one per vendor: what an operator needs to
   *  know — that a platform credential is parked, and why. */
  platform: Array<{ connectorType: string; scope: 'platform'; reason: CooldownReason; expiresAt: string }>;
  /** Workspaces' own connectors' parks, as counts by vendor, reason and how
   *  soon they lapse — never which workspace or which connector. */
  workspace: Array<{ connectorType: string; scope: 'workspace'; reason: CooldownReason; expiresWithinMinutes: number; count: number }>;
}

/** The live rows, read from the table rather than the cache, for the
 *  operator's read (GET /api/admin/vendor-cooldowns). */
export async function operatorCooldownView(): Promise<OperatorCooldownView> {
  // RLS_RAW_POOL_OK: vendor_cooldowns is platform-scoped, keyed by the
  // credential; there is no tenant scope to set.
  const result = await getPool().query<{
    credential_ref: string; connector_type: string; reason: CooldownReason; expires_at: Date | string;
  }>(
    `SELECT credential_ref, connector_type, reason, expires_at
       FROM vendor_cooldowns
      WHERE expires_at > now()
      ORDER BY connector_type, expires_at`,
  );
  const now = Date.now();
  const platform: OperatorCooldownView['platform'] = [];
  const counts = new Map<string, OperatorCooldownView['workspace'][number]>();
  for (const row of result.rows) {
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (row.credential_ref.startsWith('internal:')) {
      platform.push({
        connectorType: row.connector_type,
        scope: 'platform',
        reason: row.reason,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      continue;
    }
    const expiresWithinMinutes = Math.max(1, Math.ceil((expiresAtMs - now) / 60_000));
    const key = `${row.connector_type}|${row.reason}|${expiresWithinMinutes}`;
    const bucket = counts.get(key);
    if (bucket) bucket.count += 1;
    else counts.set(key, { connectorType: row.connector_type, scope: 'workspace', reason: row.reason, expiresWithinMinutes, count: 1 });
  }
  return { platform, workspace: [...counts.values()] };
}

/** Test seam: forget the cached set and every local park. */
export function _resetVendorGateCache(): void {
  cache = null;
  localParks.clear();
}
