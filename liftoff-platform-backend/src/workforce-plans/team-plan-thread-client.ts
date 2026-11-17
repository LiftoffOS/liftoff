// Calls into workforce-service that are made without a `req` in scope.
//
// Team-plan threads live in the `workforce` database, which this service cannot
// read, so /api/chat-shares asks workforce-service instead. Same auth shape the
// proxy uses: OIDC bearer for Cloud Run IAM, the shared service token, and the
// trusted caller headers workforce-service resolves its caller from. The
// difference from workforce-proxy.ts is that nothing here has a request to copy
// headers off, so the caller is passed in and the three trusted headers are
// written by hand.
//
// Used by the share routes (rare, user-initiated) and by the Liftoff chat when
// it hands a turn to the Chief AI Officer, which is why the header recipe is
// exported rather than living inside the one function that first needed it: two
// callers agreeing by copy is two callers that will eventually disagree.

import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';

export interface WorkforceCaller {
  tenantId: string;
  accountId: string;
  /** The caller's REAL tenant role. Never defaulted: workforce-service makes
   *  its own permission decisions from this header, so a hardcoded value would
   *  hand someone authority they do not have. */
  role: string;
  /** The person's name as the surfaces show it, for the Chief AI Officer's
   *  prompt and for whichever colleague it brings in, which attributes the
   *  message to this name. Optional because the callers that predate it do
   *  not all have one; workforce-service reads a missing name as none. */
  displayName?: string;
}

/** The header the caller's name travels in. URL-encoded on the wire, because
 *  a header value is bytes and a name is not: undici refuses a character
 *  above U+00FF outright, and the alternative is a name that arrives
 *  mangled. workforce-service decodes it (caller-context.ts). */
export const CALLER_NAME_HEADER = 'x-caller-name';

/** The wire form of a caller's name, or nothing for no name. */
export function callerNameHeader(displayName: string | null | undefined): Record<string, string> {
  const trimmed = displayName?.trim() ?? '';
  return trimmed ? { [CALLER_NAME_HEADER]: encodeURIComponent(trimmed) } : {};
}

/** The base URL of workforce-service, or null when it is not configured.
 *  Resolved per call, never at module load, so the process still starts in an
 *  environment where the service is not deployed. */
export function workforceServiceBaseUrl(): string | null {
  const base = (process.env['WORKFORCE_SERVICE_URL'] ?? '').replace(/\/$/, '');
  return base.length > 0 ? base : null;
}

/**
 * Headers for one call into workforce-service on a caller's behalf.
 *
 * Three plaintext headers carry the caller (workforce-service's
 * resolveCallerFromHeaders reads them) and a fourth carries the person's
 * name when there is one, `X-Service-Auth` proves the call came
 * from a peer service, and the OIDC bearer satisfies Cloud Run IAM. The OIDC
 * build failing is normal off-GCP and must not stop the call: locally there is
 * no IAM to satisfy.
 */
export async function buildWorkforceCallHeaders(
  targetBase: string,
  caller: WorkforceCaller,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'x-tenant-id': caller.tenantId,
    'x-account-id': caller.accountId,
    'x-tenant-role': caller.role,
    ...callerNameHeader(caller.displayName),
    ...extra,
  };

  const serviceAuthToken = process.env['WORKFORCE_SERVICE_TOKEN'];
  if (serviceAuthToken) headers['X-Service-Auth'] = serviceAuthToken;

  try {
    const oidc = await buildOidcAuthHeader(targetBase);
    for (const [k, v] of Object.entries(oidc)) headers[k] = v;
  } catch (err) {
    // Normal in local/test environments without a GCP metadata server.
    log.debug(
      { err: (err as Error).message },
      'workforce call: OIDC token build failed (ok in local/test)',
    );
  }

  return headers;
}

/**
 * Whether the recorded driver of a Chief AI Officer thread's browser is still
 * present in that thread, as workforce-service sees it (its own presence
 * table, the same 45-second window the other three surfaces use).
 *
 * A SERVICE query about the recorded driver, not an impersonated user
 * request: no tenant role is available or needed, so the headers are built
 * directly (Cloud Run OIDC plus `X-Service-Auth`) rather than through
 * `buildWorkforceCallHeaders`, whose trusted caller headers would claim an
 * identity this call does not have. Unreachable, unconfigured or non-200
 * answers null: unknown, which the sweep never acts on.
 */
export async function teamPlanDriverPresent(args: {
  tenantId: string;
  threadId: string;
  accountId: string;
}): Promise<boolean | null> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) {
    log.warn({}, 'team-plan driver presence: WORKFORCE_SERVICE_URL not configured');
    return null;
  }
  const serviceAuthToken = process.env['WORKFORCE_SERVICE_TOKEN'];
  if (!serviceAuthToken) {
    log.warn({}, 'team-plan driver presence: WORKFORCE_SERVICE_TOKEN not configured');
    return null;
  }
  const headers: Record<string, string> = { 'X-Service-Auth': serviceAuthToken };
  try {
    const oidc = await buildOidcAuthHeader(targetBase);
    for (const [k, v] of Object.entries(oidc)) headers[k] = v;
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'team-plan driver presence: OIDC token build failed (ok in local/test)');
  }
  try {
    const response = await globalThis.fetch(
      `${targetBase}/internal/team-plan/threads/${encodeURIComponent(args.threadId)}/presence/${encodeURIComponent(args.accountId)}`
        + `?tenantId=${encodeURIComponent(args.tenantId)}`,
      { method: 'GET', headers },
    );
    if (!response.ok) {
      log.warn({ status: response.status, threadId: args.threadId }, 'team-plan driver presence: workforce-service did not answer 200');
      return null;
    }
    const body = (await response.json()) as { present?: unknown };
    return typeof body.present === 'boolean' ? body.present : null;
  } catch (err) {
    log.warn({ err: (err as Error).message, threadId: args.threadId }, 'team-plan driver presence: failed to reach workforce-service');
    return null;
  }
}

export async function teamPlanThreadExists(args: {
  threadId: string;
  tenantId: string;
  accountId: string;
  role: string;
}): Promise<boolean> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) {
    log.error({}, 'team-plan share: WORKFORCE_SERVICE_URL not configured');
    return false;
  }

  const headers = await buildWorkforceCallHeaders(targetBase, {
    tenantId: args.tenantId,
    accountId: args.accountId,
    role: args.role,
  });

  try {
    const response = await globalThis.fetch(
      `${targetBase}/team-plan/threads/${encodeURIComponent(args.threadId)}?tenantId=${encodeURIComponent(args.tenantId)}`,
      { method: 'GET', headers },
    );
    return response.ok;
  } catch (err) {
    log.error(
      { err: (err as Error).message, threadId: args.threadId },
      'team-plan share: failed to reach workforce-service',
    );
    return false;
  }
}

/** One Chief AI Officer conversation as workforce-service lists it. */
export interface TeamPlanThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

/**
 * The caller's Chief AI Officer conversations, newest first. workforce-service
 * applies its own visibility rule from the caller headers; `query` is the same
 * case-insensitive title match the local surfaces apply. Unreachable service →
 * empty list, logged: a listing that cannot see one surface is still a listing.
 */
export async function listTeamPlanThreads(
  caller: WorkforceCaller,
  options: { limit?: number; query?: string } = {},
): Promise<TeamPlanThreadSummary[]> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) {
    log.error({}, 'team-plan list: WORKFORCE_SERVICE_URL not configured');
    return [];
  }

  const headers = await buildWorkforceCallHeaders(targetBase, caller);
  const search = new URLSearchParams({ tenantId: caller.tenantId });
  if (options.limit) search.set('limit', String(options.limit));
  if (options.query) search.set('query', options.query);

  try {
    const response = await globalThis.fetch(
      `${targetBase}/team-plan/threads?${search.toString()}`,
      { method: 'GET', headers },
    );
    if (!response.ok) {
      log.error({ status: response.status }, 'team-plan list: workforce-service refused');
      return [];
    }
    const body = await response.json() as { threads?: Array<{ id: string; title: string | null; updatedAt: string }> };
    return (body.threads ?? []).map((t) => ({ id: t.id, title: t.title ?? null, updatedAt: t.updatedAt }));
  } catch (err) {
    log.error({ err: (err as Error).message }, 'team-plan list: failed to reach workforce-service');
    return [];
  }
}

/** One page of the caller's Chief AI Officer conversations, as the web app's
 *  cross-surface Chat History reads them. */
export interface TeamPlanThreadPage {
  threads: Array<TeamPlanThreadSummary & { unread: boolean }>;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * One cursor page of the caller's Chief AI Officer conversations, with the
 * per-thread unread flag and the cursor workforce-service already sends.
 * Unlike listTeamPlanThreads, this THROWS on failure: the caller decides
 * whether a missing surface degrades the listing or fails it.
 */
export async function listTeamPlanThreadPage(
  caller: WorkforceCaller,
  options: { cursor?: string; limit?: number } = {},
): Promise<TeamPlanThreadPage> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) throw new Error('WORKFORCE_SERVICE_URL not configured');

  const headers = await buildWorkforceCallHeaders(targetBase, caller);
  const search = new URLSearchParams({ tenantId: caller.tenantId });
  if (options.cursor) search.set('cursor', options.cursor);
  if (options.limit) search.set('limit', String(options.limit));

  const response = await globalThis.fetch(
    `${targetBase}/team-plan/threads?${search.toString()}`,
    { method: 'GET', headers },
  );
  if (!response.ok) throw new Error(`workforce-service refused the thread list (${response.status})`);
  const body = await response.json() as {
    threads?: Array<{ id: string; title: string | null; updatedAt: string; unread?: boolean }>;
    nextCursor?: string | null;
    hasMore?: boolean;
  };
  return {
    threads: (body.threads ?? []).map((t) => ({
      id: t.id,
      title: t.title ?? null,
      updatedAt: t.updatedAt,
      unread: t.unread === true,
    })),
    nextCursor: body.nextCursor ?? null,
    hasMore: body.hasMore === true,
  };
}

// ── Workspace export feeds ──────────────────────────────────────────────
//
// Two independently bounded feeds over the Chief AI Officer's conversations,
// threads and messages, each one ordered pass keyed on (created_at, id) up to
// `asOf`. Unlike listTeamPlanThreads above, which returns [] on failure by
// design for the MCP listing, these THROW: an export that quietly wrote "no
// conversations" because the service was down would be a false record. The
// caller's tenant travels in the headers only.

export interface TeamPlanExportThread {
  id: string;
  accountId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamPlanExportMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  senderAccountId: string | null;
  attachments: Array<{ kind: string; name: string }>;
  media: Array<{ mediaId: string; filename: string }> | null;
  messageType: string | null;
  /** Contributor[] (workforce migration 028): colleagues other than the Chief
   *  AI Officer who had a hand in the reply. Absent from an older workforce
   *  image, which reads as nobody. */
  contributors?: Array<{ id: string; label: string }>;
  createdAt: string;
}

export interface TeamPlanExportOptions {
  asOf: Date;
  cursor?: string;
  limit?: number;
}

const EXPORT_FEED_TIMEOUT_MS = 10_000;

async function fetchTeamPlanExport<T extends { id: string }>(
  caller: WorkforceCaller,
  kind: 'threads' | 'messages',
  options: TeamPlanExportOptions,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) {
    throw new Error('team-plan export: WORKFORCE_SERVICE_URL not configured');
  }
  const headers = await buildWorkforceCallHeaders(targetBase, caller);
  const search = new URLSearchParams({ kind, asOf: options.asOf.toISOString() });
  if (options.cursor) search.set('cursor', options.cursor);
  if (options.limit !== undefined) search.set('limit', String(options.limit));

  const response = await globalThis.fetch(
    `${targetBase}/team-plan/export?${search.toString()}`,
    { method: 'GET', headers, signal: AbortSignal.timeout(EXPORT_FEED_TIMEOUT_MS) },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from workforce-service team-plan export (${kind})`);
  }
  const body = await response.json() as Record<string, unknown>;
  const items = body[kind];
  const nextCursor = body.nextCursor;
  // Validated, not trusted: a workforce-service that predates the feed
  // answers something else at this path.
  if (!Array.isArray(items)
    || (nextCursor !== null && typeof nextCursor !== 'string')
    || items.some((item) => !item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string')) {
    throw new Error(`Malformed team-plan export page from workforce-service (${kind})`);
  }
  return { items: items as T[], nextCursor: nextCursor as string | null };
}

export async function exportTeamPlanThreads(
  caller: WorkforceCaller,
  options: TeamPlanExportOptions,
): Promise<{ items: TeamPlanExportThread[]; nextCursor: string | null }> {
  return fetchTeamPlanExport<TeamPlanExportThread>(caller, 'threads', options);
}

export async function exportTeamPlanMessages(
  caller: WorkforceCaller,
  options: TeamPlanExportOptions,
): Promise<{ items: TeamPlanExportMessage[]; nextCursor: string | null }> {
  return fetchTeamPlanExport<TeamPlanExportMessage>(caller, 'messages', options);
}
