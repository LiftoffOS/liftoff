// The saved logins a workspace's vault holds, and the one read that resolves
// a secret.
//
// A saved login is an OVERVIEW: `{ vaultId, itemId, title, websites[],
// username }`, read from `items.list(vault)` per vault the service account
// can see, kept when the item is a Login and active. No secret is in an
// overview; the list is cached 60 s per workspace. The username is one
// `items.get` per item and is read lazily, for `web_session_list` only,
// never for matching. The secret is read only inside `resolveLogin`, only
// for the fill in progress, and is never cached.
//
// The matching rule honours the setting the person already chose per
// website in 1Password (`Website.autofillBehavior`): `Never` never matches;
// `ExactDomain` matches when the page's host and port equal the website's;
// `AnywhereOnWebsite` (the default) matches when the page host equals the
// website host or the website host is a dot-suffix of it. No public-suffix
// list. Exactly one matching Login item is a login; more than one is
// `ambiguous`; none is null.
//
// The availability rule is the whole of it: the workspace has an `active`
// `onepassword` connector. The vault the person shared is the consent
// boundary; every session in the workspace may use what is in it.
//
// Errors: a rate limit memoises "unavailable" for ten minutes and the
// matcher answers null; an auth failure takes the BYOK error path, which
// marks the connector errored. Nothing here throws out to the fill.

import type { Client, Item, ItemField, ItemOverview } from '@1password/sdk';
import { logger } from '../../infrastructure/logging';
import { getWebToolCredential, VendorConnectorErrored, VendorNotConnected } from '../web-fetch/web-tool-secrets';
import { ANY_CONNECTOR } from '../web-fetch/credential-scope';
import { markConnectorErrored } from '../web-fetch/byok-error-handler';
import { clientFor, dropOnePasswordClient } from './client';

export type AutofillBehaviorOf = 'AnywhereOnWebsite' | 'ExactDomain' | 'Never';

export interface SavedLoginWebsite {
  host: string;
  /** The explicit port, or the scheme's default when the website named
   *  none; '' when the website could not be parsed. */
  port: string;
  autofillBehavior: AutofillBehaviorOf;
}

export interface SavedLogin {
  vaultId: string;
  itemId: string;
  title: string;
  websites: SavedLoginWebsite[];
  /** Read lazily (one items.get per item), null until it is. */
  username: string | null;
}

export interface ResolvedLogin {
  username: string;
  password: string;
  /** The current TOTP code, when the item has a TOTP field that computed
   *  one. Rotates every 30 s: read again at the moment it is needed. */
  totpCode?: string;
  /** Why the TOTP field produced no code, when it has one but did not. */
  totpError?: string;
}

/** The overview cache, per workspace. */
export const SAVED_LOGINS_CACHE_TTL_MS = 60_000;
/** How long a rate-limited workspace is left alone. */
export const RATE_LIMIT_MEMO_MS = 10 * 60_000;
/** How long the availability answer is kept, either way. */
export const AVAILABILITY_CACHE_TTL_MS = 60_000;
/** Items read per batch when the listing is asked for usernames. */
export const BATCH_ITEMS = 50;

interface ListEntry { logins: SavedLogin[]; expiresAt: number }
const listCache = new Map<string, ListEntry>();
const unavailableUntil = new Map<string, number>();
const availability = new Map<string, { available: boolean; expiresAt: number }>();

/** Every cache this module keeps, for the tests. */
export function _resetSavedLoginsForTesting(): void {
  listCache.clear();
  unavailableUntil.clear();
  availability.clear();
}

/** The SDK's auth failures, by class and by the core's own message. The
 *  SDK's error classes set no `name`, so the class is read from the
 *  constructor. */
const AUTH_FAILURE = /service account token|not authenticated|right permissions|session expired|account couldn't be found/i;

function classOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : '';
}

function isAuthFailure(err: unknown): boolean {
  if (classOf(err) === 'AuthExpiredError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return AUTH_FAILURE.test(message);
}

function isRateLimit(err: unknown): boolean {
  if (classOf(err) === 'RateLimitExceededError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /rate limit exceeded/i.test(message);
}

/** No connector to read with: none connected, or every key of the workspace
 *  set aside by the pool (an invalid token cooling, an RPC that could not
 *  mark it). Not a failure to report; the source is simply unavailable. */
function isNoUsableConnector(err: unknown): boolean {
  return err instanceof VendorNotConnected || err instanceof VendorConnectorErrored;
}

/** Route an SDK failure: a rate limit memoises unavailability, an auth
 *  failure marks the connector errored through the BYOK path. Either way the
 *  caller answers "no login" rather than throwing. Logs carry no item. */
async function noteFailure(tenantId: string, connectorId: string | null, err: unknown, what: string): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (isRateLimit(err)) {
    unavailableUntil.set(tenantId, Date.now() + RATE_LIMIT_MEMO_MS);
    logger.warn({ tenantId, what, event: 'onepassword_rate_limited' }, '1Password: rate limit reached; saved logins are unavailable for ten minutes');
    return;
  }
  if (isAuthFailure(err)) {
    dropOnePasswordClient(tenantId);
    listCache.delete(tenantId);
    availability.delete(tenantId);
    if (connectorId) {
      await markConnectorErrored(tenantId, 'onepassword', connectorId, 'invalid_key', `1Password rejected the service account token during ${what}`);
    }
    logger.warn({ tenantId, what, event: 'onepassword_token_rejected' }, '1Password: the service account token was rejected; the connector is marked errored');
    return;
  }
  logger.warn({ tenantId, what, err: message, event: 'onepassword_read_failed' }, '1Password: a read failed');
}

/** A website's host and port from the URL 1Password holds, which may lack a
 *  scheme ("example.com"). */
export function parseWebsite(url: string, autofillBehavior: string): SavedLoginWebsite {
  const behavior: AutofillBehaviorOf = autofillBehavior === 'ExactDomain' || autofillBehavior === 'Never' ? autofillBehavior : 'AnywhereOnWebsite';
  const raw = (url ?? '').trim();
  const tryParse = (candidate: string): URL | null => {
    try { return new URL(candidate); } catch { return null; }
  };
  // "example.com:8443" parses as a URL whose scheme is "example.com:", so a
  // value with no explicit "scheme://" is read as https; one with an explicit
  // scheme is read as written, and only the web's schemes name a website.
  const parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? tryParse(raw) : tryParse(`https://${raw}`);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    return { host: '', port: '', autofillBehavior: behavior };
  }
  return { host: parsed.hostname.toLowerCase(), port: portOf(parsed), autofillBehavior: behavior };
}

function portOf(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'http:' ? '80' : u.protocol === 'https:' ? '443' : '';
}

/** Whether a website matches a page, under the website's own setting. */
export function websiteMatches(site: SavedLoginWebsite, page: URL): boolean {
  if (site.autofillBehavior === 'Never' || !site.host) return false;
  const host = page.hostname.toLowerCase();
  if (site.autofillBehavior === 'ExactDomain') return host === site.host && portOf(page) === site.port;
  return host === site.host || host.endsWith(`.${site.host}`);
}

/** The matching rule over a list of overviews: one match, `ambiguous`, or
 *  null. Pure, so the tests pin it without a vault. */
export function matchLogins(logins: readonly SavedLogin[], url: string): SavedLogin | 'ambiguous' | null {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return null;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
  const matched = logins.filter((login) => login.websites.some((site) => websiteMatches(site, page)));
  if (matched.length === 0) return null;
  if (matched.length > 1) return 'ambiguous';
  return matched[0];
}

function overviewOf(item: ItemOverview): SavedLogin {
  return {
    vaultId: item.vaultId,
    itemId: item.id,
    title: item.title ?? '',
    websites: (item.websites ?? []).map((w) => parseWebsite(w.url, String(w.autofillBehavior))),
    username: null,
  };
}

/**
 * The vault's active Login items.
 *
 * LOGIN ONLY, deliberately. A `Password` item carries websites too, but the
 * consent the person gave is the one they were shown, in the connector's own
 * words and in the record of processing: the LOGINS in the vault they share.
 * A Password item also holds no username, so a page needing one could not be
 * signed in from it anyway, and counting it would make two items match a site
 * that has one login. Widening this is a change to what the person agreed to,
 * not a bug fix.
 */
async function listFromVaults(client: Client): Promise<SavedLogin[]> {
  const vaults = await client.vaults.list();
  const out: SavedLogin[] = [];
  for (const vault of vaults) {
    const items = await client.items.list(vault.id, { type: 'ByState', content: { active: true, archived: false } });
    for (const item of items) {
      if (String(item.category) !== 'Login') continue;
      if (String(item.state) !== 'active') continue;
      out.push(overviewOf(item));
    }
  }
  return out;
}

/**
 * The workspace's saved logins, from the cached overview list. Empty when
 * the workspace has no usable connector, is rate limited, or the read
 * failed. With `withUsernames`, each login's username is read (one
 * `items.get` per item, cached with the list): for `web_session_list`, never
 * for matching.
 */
export async function listSavedLogins(tenantId: string, opts: { withUsernames?: boolean } = {}): Promise<SavedLogin[]> {
  if ((unavailableUntil.get(tenantId) ?? 0) > Date.now()) return [];
  let entry = listCache.get(tenantId);
  if (!entry || entry.expiresAt <= Date.now()) {
    let connectorId: string | null = null;
    try {
      const { client, connectorId: id } = await clientFor(tenantId);
      connectorId = id;
      const logins = await listFromVaults(client);
      entry = { logins, expiresAt: Date.now() + SAVED_LOGINS_CACHE_TTL_MS };
      listCache.set(tenantId, entry);
    } catch (err) {
      if (isNoUsableConnector(err)) return [];
      await noteFailure(tenantId, connectorId, err, 'listing logins');
      return [];
    }
  }
  if (opts.withUsernames) await hydrateUsernames(tenantId, entry.logins);
  return entry.logins;
}

/** The usernames of the listed logins, in ONE read per vault rather than one
 *  per item: a fifty-item vault would otherwise spend fifty of the hour's
 *  reads (a thousand on Teams and Families) every time the list is asked for
 *  with usernames. Batched at BATCH_ITEMS so a large vault stays inside the
 *  SDK's own message bound. The answers are matched by item id rather than by
 *  position, and a read that fails leaves the remaining usernames unread
 *  rather than half-attributed. */
async function hydrateUsernames(tenantId: string, logins: SavedLogin[]): Promise<void> {
  const byVault = new Map<string, SavedLogin[]>();
  for (const login of logins) {
    if (login.username !== null) continue;
    const group = byVault.get(login.vaultId);
    if (group) group.push(login);
    else byVault.set(login.vaultId, [login]);
  }
  for (const [vaultId, group] of byVault) {
    for (let i = 0; i < group.length; i += BATCH_ITEMS) {
      const batch = group.slice(i, i + BATCH_ITEMS);
      let connectorId: string | null = null;
      try {
        const { client, connectorId: id } = await clientFor(tenantId);
        connectorId = id;
        const answer = await client.items.getAll(vaultId, batch.map((l) => l.itemId));
        const byId = new Map<string, Item>();
        for (const one of answer.individualResponses ?? []) {
          if (one.content) byId.set(one.content.id, one.content);
        }
        for (const login of batch) {
          const item = byId.get(login.itemId);
          login.username = item ? (usernameOf(item.fields ?? []) ?? '') : '';
        }
      } catch (err) {
        if (!isNoUsableConnector(err)) await noteFailure(tenantId, connectorId, err, 'reading usernames');
        return;
      }
    }
  }
}

/** The login for a page: exactly one match, `ambiguous`, or null. Reads the
 *  cached overviews only; never a secret. */
export async function findLoginForUrl(tenantId: string, url: string): Promise<SavedLogin | 'ambiguous' | null> {
  const logins = await listSavedLogins(tenantId);
  if (logins.length === 0) return null;
  return matchLogins(logins, url);
}

function fieldType(field: ItemField): string {
  return String(field.fieldType);
}

/** A field's value when it has one. An EMPTY value is no value: a Login item
 *  that carries only a password has an empty username field, and typing that
 *  empty string into a sign-in form clears the box and submits it. */
function valueOf(field: ItemField | undefined): string | null {
  return field && typeof field.value === 'string' && field.value.length > 0 ? field.value : null;
}

/** Username = the field with id `username`, else the first Text or Email
 *  field that holds something. */
export function usernameOf(fields: readonly ItemField[]): string | null {
  return valueOf(fields.find((f) => f.id === 'username'))
    ?? valueOf(fields.find((f) => (fieldType(f) === 'Text' || fieldType(f) === 'Email') && typeof f.value === 'string' && f.value.length > 0));
}

/** Password = the field with id `password`, else the first Concealed field
 *  that holds something. */
function passwordOf(fields: readonly ItemField[]): string | null {
  return valueOf(fields.find((f) => f.id === 'password'))
    ?? valueOf(fields.find((f) => fieldType(f) === 'Concealed' && typeof f.value === 'string' && f.value.length > 0));
}

/** The current code of the first TOTP field, or why there is none. */
function totpOf(fields: readonly ItemField[]): { code?: string; error?: string } {
  const totp = fields.find((f) => fieldType(f) === 'Totp');
  if (!totp) return {};
  const details = totp.details;
  if (details && details.type === 'Otp') {
    if (details.content?.code) return { code: details.content.code };
    return { error: details.content?.errorMessage || 'the one-time code could not be computed' };
  }
  return { error: 'the one-time code could not be computed' };
}

/** The fields of an item as the fill needs them. Pure, so the tests pin the
 *  extraction on an Item fixture. */
export function credentialsOf(item: Pick<Item, 'fields'>): ResolvedLogin | null {
  const fields = item.fields ?? [];
  const username = usernameOf(fields);
  const password = passwordOf(fields);
  if (username === null || password === null) return null;
  const totp = totpOf(fields);
  return {
    username,
    password,
    ...(totp.code ? { totpCode: totp.code } : {}),
    ...(totp.error ? { totpError: totp.error } : {}),
  };
}

/**
 * One `items.get`: the username, the password and the current TOTP code.
 * `unusable` when the item holds no username and password pair; null when
 * the read failed, with the failure routed (rate limit memo, BYOK error
 * path) and never thrown.
 */
export async function resolveLogin(tenantId: string, login: Pick<SavedLogin, 'vaultId' | 'itemId'>): Promise<ResolvedLogin | 'unusable' | null> {
  if ((unavailableUntil.get(tenantId) ?? 0) > Date.now()) return null;
  let connectorId: string | null = null;
  try {
    const { client, connectorId: id } = await clientFor(tenantId);
    connectorId = id;
    const item = await client.items.get(login.vaultId, login.itemId);
    return credentialsOf(item) ?? 'unusable';
  } catch (err) {
    if (isNoUsableConnector(err)) return null;
    await noteFailure(tenantId, connectorId, err, 'resolving a login');
    return null;
  }
}

/**
 * The availability rule: the workspace has an `active` `onepassword`
 * connector whose token the pool will hand out, read through the same cached
 * credential lookup every vendor uses (the 60 s connector cache and the
 * pool's cooldowns), with the answer kept 60 s either way so a workspace
 * without the connector pays one lookup a minute at most. A rate-limited
 * workspace is unavailable until its memo lapses.
 */
export async function isLoginSourceAvailable(tenantId: string): Promise<boolean> {
  if ((unavailableUntil.get(tenantId) ?? 0) > Date.now()) return false;
  const hit = availability.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.available;
  let available = false;
  try {
    await getWebToolCredential(tenantId, 'onepassword', ANY_CONNECTOR);
    available = true;
  } catch (err) {
    if (!isNoUsableConnector(err)) {
      logger.warn({ tenantId, err: (err as Error).message, event: 'onepassword_availability_unreadable' }, '1Password: the connector could not be read; saved logins are off for this minute');
    }
    available = false;
  }
  availability.set(tenantId, { available, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
  return available;
}
