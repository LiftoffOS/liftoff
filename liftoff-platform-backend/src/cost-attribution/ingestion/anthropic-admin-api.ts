// Anthropic Admin API client — usage and cost reports.
//
// These live on the ORGANISATION Admin API, not the Messages API, and they are
// not exposed by @anthropic-ai/sdk at any version this repo has installed (0.115
// ships `messages` and `beta/{agents,environments,memory-stores,messages,
// sessions,skills,tunnels,vaults}` and nothing else). Calling them means a
// direct request; reaching for the SDK is what left the reconciler inert.
//
// They also need an ADMIN credential, which is a different thing from the
// per-group ANTHROPIC_API_KEY_* keys used to send messages. A message key
// returns 401 here.
//
// The two reports answer different questions and only one of them is per-key:
//
//   usage_report/messages  group_by=api_key_id  -> TOKENS, per API key
//   cost_report            group_by=description|workspace_id -> USD, NOT per key
//
// That asymmetry is the whole reason reconciliation is per-group on tokens and
// organisation-wide on dollars.

import { log } from '../../infrastructure/logging';

const API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 30_000;
/** A day of buckets is one page; the cap stops a pagination bug spinning. */
const MAX_PAGES = 20;

export interface ApiKeyTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Admin credentials come in two shapes and the docs show both. An admin API key
 * (`sk-ant-admin...`) goes in `x-api-key`; an OAuth token goes in
 * `Authorization: Bearer`. Choosing on the prefix means either provisioning
 * works, rather than half of them failing with a 401 nobody reads.
 */
function authHeaders(credential: string): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    'accept': 'application/json',
  };
  if (credential.startsWith('sk-ant-admin')) {
    headers['x-api-key'] = credential;
  } else {
    headers['authorization'] = `Bearer ${credential}`;
  }
  return headers;
}

async function getJson(
  url: string,
  credential: string,
): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: authHeaders(credential), signal: ctrl.signal });
    if (!res.ok) {
      // 401/403 here almost always means a message key was supplied instead of
      // an admin one, or the org lacks the analytics scope. Say so with the
      // status rather than collapsing it into "unavailable".
      const body = await res.text().catch(() => '');
      log.warn(
        { url: url.split('?')[0], status: res.status, body: body.slice(0, 300) },
        'anthropic-admin-api: non-2xx',
      );
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    log.warn(
      { url: url.split('?')[0], err: (err as Error).message },
      'anthropic-admin-api: request failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every API key in the organisation, with its id, name and status.
 *
 * Anthropic reports usage against the key ID (`apikey_01...`) and never the
 * secret, so something has to connect the two. This is what lets that be
 * DISCOVERED rather than configured.
 *
 * STATUS IS PART OF THE ANSWER, not a detail to filter later. The organisation
 * holds an `active` key per purpose group inside a workspace and an older
 * `inactive` or `archived` twin of the same NAME outside one — matching on name
 * alone finds the dead twin about half the time and reports a spending group as
 * having no vendor usage at all.
 *
 * Returns null when the list could not be obtained, which is different from an
 * empty list: empty means the organisation holds no keys, and that is an answer.
 */
export async function fetchOrgApiKeys(
  credential: string,
): Promise<Array<{ id: string; name: string; status: string }> | null> {
  const body = await getJson('https://api.anthropic.com/v1/organizations/api_keys?limit=1000', credential);
  if (!body) return null;
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows
    .map((r) => r as { id?: unknown; name?: unknown; status?: unknown })
    .filter((r): r is { id: string; name: string; status: string } =>
      typeof r.id === 'string' && typeof r.name === 'string' && typeof r.status === 'string');
}

/**
 * RFC 3339 bounds for one UTC calendar day, HALF-OPEN: `[00:00:00Z, next day
 * 00:00:00Z)`.
 *
 * The obvious spelling — same day, `23:59:59Z` — is wrong on both reports and
 * wrong in two DIFFERENT ways, which is why it survived:
 *
 *   * `cost_report` refuses it outright: `invalid_request_error`, "ending date
 *     must be after starting date". That surfaces as a null and is recorded as
 *     the -1 sentinel, so the row says "vendor side missing".
 *   * `usage_report/messages` accepts it and returns `{"data":[]}` — no error,
 *     no buckets. An empty result is a LEGITIMATE answer from this API ("served
 *     the report, no usage"), so it is indistinguishable from a real zero and
 *     every group reconciles against nothing while the job logs success.
 *
 * The second is the dangerous one and the reason this is a comment rather than a
 * one-liner. Against the live API, the same day/23:59:59 range returns an empty
 * list for a day on which the half-open range reports millions of tokens.
 */
function dayBounds(dateStr: string): { start: string; end: string } {
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: `${dateStr}T00:00:00Z`, end: `${next.toISOString().slice(0, 10)}T00:00:00Z` };
}

/**
 * Token usage for one UTC day, keyed by Anthropic API key id.
 *
 * Returns null when the report could not be obtained at all, which is different
 * from an empty map: an empty map means Anthropic served the report and it had
 * no usage, and that IS a comparable answer.
 */
export async function fetchUsageByApiKey(
  dateStr: string,
  credential: string,
): Promise<Map<string, ApiKeyTokenUsage> | null> {
  const { start, end } = dayBounds(dateStr);
  const totals = new Map<string, ApiKeyTokenUsage>();
  let page: string | undefined;
  let gotAnyPage = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({
      starting_at: start,
      ending_at: end,
      bucket_width: '1d',
    });
    params.append('group_by[]', 'api_key_id');
    if (page) params.set('page', page);

    const body = await getJson(
      `${API_BASE}/v1/organizations/usage_report/messages?${params.toString()}`,
      credential,
    );
    if (!body) return gotAnyPage ? totals : null;
    gotAnyPage = true;

    for (const bucket of (body.data as Array<Record<string, unknown>>) ?? []) {
      for (const row of (bucket.results as Array<Record<string, unknown>>) ?? []) {
        const keyId = typeof row.api_key_id === 'string' ? row.api_key_id : null;
        if (!keyId) continue;
        const prev = totals.get(keyId) ?? { inputTokens: 0, outputTokens: 0 };
        // Cache reads and cache writes are input tokens that Anthropic bills and
        // that our own records count, so they belong in the comparison. Leaving
        // them out would show a permanent deficit on every cache-heavy group.
        const cacheCreation = (row.cache_creation ?? {}) as Record<string, unknown>;
        prev.inputTokens +=
          num(row.uncached_input_tokens) +
          num(row.cache_read_input_tokens) +
          num(cacheCreation.ephemeral_1h_input_tokens) +
          num(cacheCreation.ephemeral_5m_input_tokens);
        prev.outputTokens += num(row.output_tokens);
        totals.set(keyId, prev);
      }
    }

    if (body.has_more === true && typeof body.next_page === 'string') {
      page = body.next_page;
    } else {
      return totals;
    }
  }

  log.warn({ dateStr }, 'anthropic-admin-api: usage report hit the page cap');
  return totals;
}

/**
 * Organisation-wide cost in USD for one UTC day.
 *
 * Not divisible by API key — Anthropic groups cost by description or workspace
 * only. Returns null when the report was unavailable, which includes the
 * documented case of the org not being on a plan that exposes it.
 */
export async function fetchOrgCostUsd(
  dateStr: string,
  credential: string,
): Promise<number | null> {
  const { start, end } = dayBounds(dateStr);
  let page: string | undefined;
  let total = 0;
  let gotAnyPage = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({
      starting_at: start,
      ending_at: end,
      bucket_width: '1d',
    });
    if (page) params.set('page', page);

    const body = await getJson(
      `${API_BASE}/v1/organizations/cost_report?${params.toString()}`,
      credential,
    );
    if (!body) return gotAnyPage ? total : null;
    gotAnyPage = true;

    for (const bucket of (body.data as Array<Record<string, unknown>>) ?? []) {
      for (const row of (bucket.results as Array<Record<string, unknown>>) ?? []) {
        // `amount` is a decimal STRING and the currency is stated per row. A
        // non-USD row must not be summed into a USD total as though the number
        // were interchangeable.
        const currency = typeof row.currency === 'string' ? row.currency : 'USD';
        if (currency !== 'USD') {
          log.warn({ currency }, 'anthropic-admin-api: skipping non-USD cost row');
          continue;
        }
        total += num(row.amount);
      }
    }

    if (body.has_more === true && typeof body.next_page === 'string') {
      page = body.next_page;
    } else {
      return total;
    }
  }

  log.warn({ dateStr }, 'anthropic-admin-api: cost report hit the page cap');
  return total;
}

/** Numbers arrive as number or decimal string depending on the field. */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
