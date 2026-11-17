// Per-provider identity fetchers for API-key (non-OAuth) connectors.
//
// Mirrors identity-fetchers.ts but takes a raw credentials object — most
// API-key connectors don't have an OAuth access token, so the identity
// lookup must be done with whatever field the user supplied (api key,
// subdomain, workspace URL, …).
//
// For URL/subdomain-shaped connectors (woocommerce, bamboohr, databricks,
// sentry) the identifier is the URL/subdomain itself — there's no remote
// whoami needed. For key-only connectors (sendgrid, trello, cal_com,
// mailchimp) we hit the provider's account endpoint.
//
// Returning null is the "single-instance" fallback signal, same as
// identity-fetchers.ts. The OAuth-key callback that calls this still
// completes the connection — it just doesn't get a multi-instance
// disambiguator written into config.

import { createHash } from 'crypto';
import { AuthExpiredError, RateLimitExceededError, createClient as createOnePasswordClient } from '@1password/sdk';
import { logger } from '../infra/logging.js';
import type { ExternalIdentity } from './identity-fetchers.js';

type ApiKeyIdentityFetcher = (
  fields: Record<string, unknown>,
) => Promise<ExternalIdentity | null>;

/** Thrown by strict-validation fetchers when the vendor explicitly rejects
 *  the supplied credentials (HTTP 401/403/402). The connect handler turns
 *  this into a 400 response so the user gets a clear error at connect time
 *  rather than discovering at first tool call. */
export class InvalidCredentialError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly connectorType: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidCredentialError';
  }
}

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

async function getJson<T = Record<string, unknown>>(
  url: string,
  headers: Record<string, string>,
): Promise<T | null> {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _postJson<T = Record<string, unknown>>(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<T | null> {
  try {
    const resp = await fetch(url, { method: 'POST', headers, body });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Strict variant of getJson — distinguishes "vendor rejected the key"
 *  from "vendor down / no data". Throws `InvalidCredentialError` on
 *  401/403/402 so the connect handler can surface a clean 400.
 *  Other failures (network errors, 5xx) return null which the BYOK
 *  fetchers translate into the hashed-key fallback id. */
async function strictGetJson<T = Record<string, unknown>>(
  url: string,
  headers: Record<string, string>,
  connectorType: string,
): Promise<T | null> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch {
    return null;
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidCredentialError(
      resp.status, connectorType,
      `${connectorType}: vendor rejected the API key (${resp.status})`,
    );
  }
  if (resp.status === 402) {
    throw new InvalidCredentialError(
      resp.status, connectorType,
      `${connectorType}: vendor account out of credit (${resp.status})`,
    );
  }
  if (!resp.ok) return null;
  return (await resp.json()) as T;
}

async function strictPostJson<T = Record<string, unknown>>(
  url: string,
  headers: Record<string, string>,
  body: string,
  connectorType: string,
): Promise<T | null> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers, body });
  } catch {
    return null;
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidCredentialError(
      resp.status, connectorType,
      `${connectorType}: vendor rejected the API key (${resp.status})`,
    );
  }
  if (resp.status === 402) {
    throw new InvalidCredentialError(
      resp.status, connectorType,
      `${connectorType}: vendor account out of credit (${resp.status})`,
    );
  }
  if (!resp.ok) return null;
  return (await resp.json()) as T;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Connector types whose identity-fetcher uses `strictGetJson`/`strictPostJson`
 *  and whose connect handler must reject the connection on
 *  `InvalidCredentialError`. The six BYOK web-tool vendors require this so
 *  bad keys surface at connect time, not first tool call. */
export const STRICT_VALIDATION_CONNECTOR_TYPES = new Set([
  'firecrawl', 'anchor_browser', 'browserbase', 'tavily', 'exa', 'webclaw',
  'browser_use', 'steel', 'onepassword',
]);

// ─── SendGrid ──────────────────────────────────────────────────────────
// /v3/user/account → { type } ; /v3/user/profile → { email, first_name, ... }
const fetchSendgridIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  const profile = await getJson('https://api.sendgrid.com/v3/user/profile', {
    Authorization: `Bearer ${apiKey}`,
  });
  if (!profile) return null;
  const email = s(profile.email);
  const first = s(profile.first_name);
  const last = s(profile.last_name);
  const fullName = [first, last].filter(Boolean).join(' ');
  const label = email ?? (fullName.length > 0 ? fullName : undefined);
  // SendGrid doesn't expose a stable account id on /profile; use the email
  // as the key (every SendGrid account has one).
  const id = email ?? label;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Trello ────────────────────────────────────────────────────────────
const fetchTrelloIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  const apiToken = s(fields.apiToken);
  if (!apiKey || !apiToken) return null;
  const data = await getJson(
    `https://api.trello.com/1/members/me?key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(apiToken)}`,
    {},
  );
  if (!data) return null;
  const id = s(data.id) ?? s(data.username);
  const label = s(data.username) ?? s(data.fullName) ?? s(data.email) ?? id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── WooCommerce ───────────────────────────────────────────────────────
// Site-URL-keyed; no whoami needed — the store URL IS the identifier.
const fetchWooCommerceIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const url = s(fields.siteUrl);
  if (!url) return null;
  const normalized = url.replace(/\/$/, '');
  return { externalAccountId: normalized, externalAccountLabel: normalized };
};

// ─── BambooHR ──────────────────────────────────────────────────────────
// Subdomain-keyed; BambooHR has /api/v1/employees/0 (employee 0 = current
// user) but a simple subdomain identity is enough for the UI.
const fetchBambooHrIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const subdomain = s(fields.subdomain);
  if (!subdomain) return null;
  return {
    externalAccountId: subdomain,
    externalAccountLabel: `${subdomain}.bamboohr.com`,
  };
};

// ─── Cal.com ───────────────────────────────────────────────────────────
const fetchCalComIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  const data = await getJson(
    `https://api.cal.com/v1/me?apiKey=${encodeURIComponent(apiKey)}`,
    {},
  );
  // Cal.com responses: either { user: {...} } or top-level fields.
  const u = (data?.user ?? data) as Record<string, unknown> | undefined;
  if (!u) return null;
  const id = s(u.id) ?? s(u.email) ?? s(u.username);
  const label = s(u.email) ?? s(u.username) ?? s(u.name) ?? id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Mailchimp ─────────────────────────────────────────────────────────
// Mailchimp keys carry the datacenter suffix (e.g. "xxx-us1"). The /3.0/
// root endpoint returns account info.
const fetchMailchimpIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  const dc = apiKey.split('-')[1];
  if (!dc) return null;
  // Mailchimp uses HTTP Basic with "anystring:<apikey>".
  const basic = Buffer.from(`apikey:${apiKey}`).toString('base64');
  const data = await getJson(`https://${dc}.api.mailchimp.com/3.0/`, {
    Authorization: `Basic ${basic}`,
  });
  if (!data) return null;
  const id = s(data.account_id) ?? s(data.account_name) ?? s(data.username);
  const label =
    s(data.account_name) ??
    s(data.email) ??
    s(data.username) ??
    `mailchimp-${dc}`;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Sentry ────────────────────────────────────────────────────────────
// Sentry has /api/0/projects/ — but a simpler identifier for the UI is the
// MCP URL the user supplied (defaults to sentry.io). Use that.
const fetchSentryIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const url = s(fields.sentryUrl) ?? 'https://sentry.io';
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  // Try /api/0/ for org info; falls back to URL.
  const data = await getJson('https://sentry.io/api/0/organizations/', {
    Authorization: `Bearer ${apiKey}`,
  });
  if (Array.isArray(data) && data.length > 0) {
    const org = data[0] as { slug?: string; name?: string; id?: string };
    if (org.id) {
      return {
        externalAccountId: org.id,
        externalAccountLabel: org.slug ?? org.name ?? `sentry-${org.id}`,
      };
    }
  }
  // Fall back to URL.
  return { externalAccountId: url, externalAccountLabel: url };
};

// ─── Databricks ────────────────────────────────────────────────────────
// Workspace-URL-keyed; the URL IS the identifier.
const fetchDatabricksIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const url = s(fields.workspaceUrl);
  if (!url) return null;
  const normalized = url.replace(/\/$/, '');
  return { externalAccountId: normalized, externalAccountLabel: normalized };
};

// ─── Plaid ─────────────────────────────────────────────────────────────
// Plaid uses client_id + secret per environment (sandbox/dev/prod). It
// doesn't have a per-account whoami suitable for multi-instance.
// Fall back to environment name as a coarse identifier.
const fetchPlaidIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const env = s(fields.environment) ?? s(fields.plaidEnvironment) ?? 'production';
  const clientId = s(fields.clientId) ?? s(fields.plaidClientId);
  if (!clientId) return null;
  return {
    externalAccountId: `${clientId}:${env}`,
    externalAccountLabel: `Plaid ${env}`,
  };
};

// ─── Firecrawl ─────────────────────────────────────────────────────────
// All six BYOK web-tool fetchers below use `strictGetJson`/`strictPostJson`
// so a 401/403/402 from the vendor surfaces as `InvalidCredentialError` —
// the connect handler turns that into a 400 response and rejects the
// connector creation. Other failures (network, 5xx) still return null and
// fall through to the hashed-key fallback id so a transient vendor outage
// doesn't block connects.
// Firecrawl exposes `team_id` but no team name / email / workspace label.
// Returning `null` for externalAccountLabel lets the Connections UI fall
// through to the masked apiKeyHint instead of echoing "Firecrawl" twice.
const fetchFirecrawlIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  const usage = await strictGetJson('https://api.firecrawl.dev/v1/team/credit-usage', {
    Authorization: `Bearer ${apiKey}`,
  }, 'firecrawl');
  if (!usage) {
    return { externalAccountId: `fc_${sha256hex(apiKey).slice(0, 16)}`, externalAccountLabel: null };
  }
  const teamId = s((usage as { team_id?: unknown }).team_id);
  const id = teamId ?? `fc_${sha256hex(apiKey).slice(0, 16)}`;
  return { externalAccountId: id, externalAccountLabel: null };
};

// ─── Anchor Browser ────────────────────────────────────────────────────
// Anchor Browser exposes `organization_id` but no org name. Same null-label
// pattern as Firecrawl/Tavily/Exa.
const fetchAnchorBrowserIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  const billing = await strictGetJson('https://api.anchorbrowser.io/v1/billing', {
    'anchor-api-key': apiKey,
  }, 'anchor_browser');
  if (!billing) {
    return { externalAccountId: `anchor_${sha256hex(apiKey).slice(0, 16)}`, externalAccountLabel: null };
  }
  const orgId = s((billing as { organization_id?: unknown }).organization_id);
  const id = orgId ?? `anchor_${sha256hex(apiKey).slice(0, 16)}`;
  return { externalAccountId: id, externalAccountLabel: null };
};

// ─── Browserbase ───────────────────────────────────────────────────────
const fetchBrowserbaseIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  const projectId = s(fields.projectId);
  if (!apiKey || !projectId) return null;
  const project = await strictGetJson(
    `https://api.browserbase.com/v1/projects/${encodeURIComponent(projectId)}`,
    { 'X-BB-API-Key': apiKey },
    'browserbase',
  );
  if (!project) {
    // Vendor unreachable — projectId is still a deterministic id we can
    // store, but we can't fetch the human-readable project name yet. Null
    // the label so the UI falls through to the masked apiKeyHint rather
    // than echoing the vendor name.
    return { externalAccountId: projectId, externalAccountLabel: null };
  }
  // Browserbase is the one BYOK vendor that exposes a meaningful per-account
  // label (the project name). Use it directly; the UI shows e.g.
  // "Browserbase / My Project" rather than the apiKeyHint fallback.
  const name = s((project as { name?: unknown }).name);
  return { externalAccountId: projectId, externalAccountLabel: name ?? null };
};

// ─── Tavily ────────────────────────────────────────────────────────────
// GET https://api.tavily.com/usage  (per Tavily docs)
//   Response shape: { key: {...}, account: { current_plan, ... } }
// There is no stable account_id field in the response. Label is null so
// the Connections UI shows the masked apiKeyHint instead of echoing
// "Tavily" twice. A 401/403 still throws via strictGetJson and the
// connect handler rejects the connection.
const fetchTavilyIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  await strictGetJson('https://api.tavily.com/usage', {
    Authorization: `Bearer ${apiKey}`,
  }, 'tavily');
  return {
    externalAccountId: `tavily_${sha256hex(apiKey).slice(0, 16)}`,
    externalAccountLabel: null,
  };
};

// ─── Exa ───────────────────────────────────────────────────────────────
// Exa has no whoami / billing endpoint either; same null-label pattern.
const fetchExaIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  // The cheapest validation probe is a 1-result search. Cost on the
  // customer's account ≈ $0.001 — acceptable at-connect cost in exchange
  // for surfacing a bad key immediately.
  const probe = await strictPostJson('https://api.exa.ai/search', {
    'x-api-key': apiKey, 'Content-Type': 'application/json',
  }, JSON.stringify({ query: 'ok', numResults: 1 }), 'exa');
  if (!probe) {
    return { externalAccountId: `exa_${sha256hex(apiKey).slice(0, 16)}`, externalAccountLabel: null };
  }
  const id = sha256hex(apiKey).slice(0, 16);
  return { externalAccountId: `exa_${id}`, externalAccountLabel: null };
};

// ─── WebClaw ───────────────────────────────────────────────────────────
// WebClaw exposes account_id but no account name; null label pattern.
const fetchWebClawIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  const account = await strictGetJson('https://api.webclaw.io/v1/account', {
    Authorization: `Bearer ${apiKey}`,
  }, 'webclaw');
  if (!account) {
    return { externalAccountId: `webclaw_${sha256hex(apiKey).slice(0, 16)}`, externalAccountLabel: null };
  }
  const accountId = s((account as { account_id?: unknown; id?: unknown }).account_id ?? (account as { id?: unknown }).id);
  const id = accountId ?? `webclaw_${sha256hex(apiKey).slice(0, 16)}`;
  return { externalAccountId: id, externalAccountLabel: null };
};

// ─── Browser Use ───────────────────────────────────────────────────────
// /api/v2/profiles is the cheapest endpoint that proves the key: it answers
// 200 on a valid key even when the account balance is $0.00, so a tenant can
// connect before topping up and only discovers a funding problem at first
// session create (402 -> insufficient_funds). An invalid key and a missing
// header both answer 401, which strictGetJson turns into
// InvalidCredentialError. The response carries no stable account identifier
// (`userId` is null on the profile rows), so the key hash is the id and the
// label is null — same pattern as Anchor Browser, Firecrawl, Tavily and Exa.
const fetchBrowserUseIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  await strictGetJson('https://api.browser-use.com/api/v2/profiles', {
    'X-Browser-Use-API-Key': apiKey,
  }, 'browser_use');
  return {
    externalAccountId: `browser_use_${sha256hex(apiKey).slice(0, 16)}`,
    externalAccountLabel: null,
  };
};

// ─── Steel ──────────────────────────────────────────────────────────────
// GET /v1/sessions?limit=1 is the cheapest call that proves the key: it
// answers 200 with the account's session list (empty on a fresh account) on a
// valid key, and 401 on an invalid one (verified against the live
// API with both a real and a made-up key), which strictGetJson turns into
// InvalidCredentialError. Steel bills usage with auto top-up, so there is no
// "connected but unfunded" state to detect here. The response carries no
// stable account identifier, so the key hash is the id and the label is null,
// as for Browser Use, Anchor, Firecrawl, Tavily and Exa.
const fetchSteelIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const apiKey = s(fields.apiKey);
  if (!apiKey) return null;
  await strictGetJson('https://api.steel.dev/v1/sessions?limit=1', {
    'steel-api-key': apiKey,
  }, 'steel');
  return {
    externalAccountId: `steel_${sha256hex(apiKey).slice(0, 16)}`,
    externalAccountLabel: null,
  };
};

// ─── 1Password ──────────────────────────────────────────────────────────
// The credential is a service-account token, and the SDK signs in with it
// as the client is created: a malformed or revoked token fails there, an
// expired one surfaces as AuthExpiredError, and either is the same refusal
// strictGetJson makes of a 401. `vaults.list()` then names what the token
// reaches. The vault names are the label because the vault is the consent
// boundary: the person sees which vault the runtime will read logins from.
// A token that reaches no vault is accepted with a null label rather than
// refused, since the person may share a vault after connecting. A rate
// limit or a network fault is not evidence about the token, so those fall
// through to the single-instance fallback like any other vendor outage.
const ONEPASSWORD_AUTH_FAILURE = /service account token|not authenticated|right permissions|session expired|account couldn't be found/i;

const fetchOnePasswordIdentity: ApiKeyIdentityFetcher = async (fields) => {
  const token = s(fields.apiKey);
  if (!token) return null;
  let vaultTitles: string[];
  try {
    const client = await createOnePasswordClient({
      auth: token,
      integrationName: 'Liftoff',
      integrationVersion: process.env.SERVICE_VERSION ?? '0.1.0',
    });
    const vaults = await client.vaults.list();
    vaultTitles = vaults.map((v) => v.title).filter((t) => t.length > 0);
  } catch (err) {
    if (err instanceof RateLimitExceededError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AuthExpiredError || ONEPASSWORD_AUTH_FAILURE.test(message)) {
      throw new InvalidCredentialError(
        401, 'onepassword',
        'onepassword: vendor rejected the service account token (401)',
      );
    }
    throw err;
  }
  return {
    externalAccountId: `onepassword_${sha256hex(token).slice(0, 16)}`,
    externalAccountLabel: vaultTitles.length > 0 ? vaultTitles.join(', ') : null,
  };
};

const fetchersByType: Record<string, ApiKeyIdentityFetcher> = {
  sendgrid: fetchSendgridIdentity,
  trello: fetchTrelloIdentity,
  woocommerce: fetchWooCommerceIdentity,
  bamboohr: fetchBambooHrIdentity,
  cal_com: fetchCalComIdentity,
  mailchimp: fetchMailchimpIdentity,
  sentry: fetchSentryIdentity,
  databricks: fetchDatabricksIdentity,
  plaid: fetchPlaidIdentity,
  firecrawl:      fetchFirecrawlIdentity,
  anchor_browser: fetchAnchorBrowserIdentity,
  browserbase:    fetchBrowserbaseIdentity,
  tavily:         fetchTavilyIdentity,
  exa:            fetchExaIdentity,
  webclaw:        fetchWebClawIdentity,
  browser_use:    fetchBrowserUseIdentity,
  steel:          fetchSteelIdentity,
  onepassword:    fetchOnePasswordIdentity,
};

/**
 * Fetch an external identity for an API-key-authenticated connector. Same
 * contract as fetchExternalIdentity() but takes the raw credential fields
 * directly. Returns null when no fetcher is registered or when the lookup
 * doesn't yield a stable id.
 */
export async function fetchApiKeyIdentity(
  connectorType: string,
  fields: Record<string, unknown>,
): Promise<ExternalIdentity | null> {
  const fetcher = fetchersByType[connectorType];
  if (!fetcher) {
    logger.info(
      { connectorType },
      'api-key identity-fetch: no fetcher registered (single-instance)',
    );
    return null;
  }
  try {
    return await fetcher(fields);
  } catch (err) {
    // InvalidCredentialError must propagate so the connect handler can
    // reject the connection with a 400. Any other thrown error is logged
    // and the connect falls back to single-instance behavior (matches
    // pre-BYOK SendGrid/Trello semantics — the vendor's whoami being down
    // shouldn't block connects).
    if (err instanceof InvalidCredentialError) throw err;
    logger.warn(
      { connectorType, error: (err as Error).message },
      'api-key identity-fetch: fetcher threw',
    );
    return null;
  }
}

/** Used by tests / introspection. */
export function apiKeyConnectorSupportsMultiInstance(connectorType: string): boolean {
  return connectorType in fetchersByType;
}
