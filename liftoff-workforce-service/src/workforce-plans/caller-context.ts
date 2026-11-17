// Caller resolution from the trusted proxy headers.
//
// Every team-plan route is reached through platform-backend's /api/team-plan
// proxy, which authenticates the user and sets x-tenant-id, x-account-id and
// x-tenant-role, plus x-caller-name when it knows the person's name. This
// service never sees a Firebase token.
//
// Lifted out of chat-router.ts so the presence routes resolve the caller the
// same way rather than growing a second copy that can drift.

import type { FastifyRequest } from 'fastify';
import type { TenantMemberRole } from './chat-repository.js';

export interface CallerContext {
  accountId: string;
  tenantId: string;
  role: TenantMemberRole;
  /** The person's name as the surfaces show it, when platform-backend sent
   *  one: the Chief AI Officer's prompt names the caller, and a colleague it
   *  brings in attributes the message to this name. Absent for a caller that
   *  predates the header. */
  displayName?: string;
  /** Present when the turn came through somewhere other than the dashboard:
   *  a coding tool, or a Slack or Teams workspace. platform-backend sends it
   *  as x-origin, and every workspace action the Chief AI Officer
   *  performs carries it back so the audit row says where the request came
   *  from. */
  origin?: CallerOrigin;
}

export type CallerVia = 'mcp' | 'slack' | 'teams';

export interface CallerOrigin {
  via: CallerVia;
  /** The coding tool's name, or the chat workspace's id. */
  client: string;
  /** The anchor token id for a coding tool; empty for a chat workspace. */
  credentialId: string;
}

export const LIFTOFF_ORIGIN_HEADER = 'x-origin';

/** The header the person's name travels in. platform-backend URL-encodes it
 *  (a header value is bytes and a name is not; see its
 *  team-plan-thread-client.ts), so it is decoded here. */
export const CALLER_NAME_HEADER = 'x-caller-name';

/** Longer than any name a person types, and a ceiling on what a prompt
 *  line and a stored sender label will carry. */
const MAX_CALLER_NAME_CHARS = 200;

/** Parse the name header platform-backend sends. Anything malformed reads as
 *  no name rather than failing the turn: the name is attribution, not
 *  authorization. */
export function parseCallerNameHeader(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // Control characters have no place in a name and could break the prompt
  // line it lands on.
  // eslint-disable-next-line no-control-regex
  const cleaned = decoded.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_CALLER_NAME_CHARS);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Parse the origin header platform-backend sends. Anything malformed reads as
 *  no origin rather than failing the turn. */
export function parseOriginHeader(raw: unknown): CallerOrigin | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as { via?: unknown; client?: unknown; credentialId?: unknown };
    if (parsed.via !== 'mcp' && parsed.via !== 'slack' && parsed.via !== 'teams') return undefined;
    return {
      via: parsed.via,
      client: typeof parsed.client === 'string' ? parsed.client : '',
      credentialId: typeof parsed.credentialId === 'string' ? parsed.credentialId : '',
    };
  } catch {
    return undefined;
  }
}

/** The caller headers for a call back into platform-backend on this person's
 *  behalf — the reverse direction of platform-backend's
 *  buildWorkforceCallHeaders — including the origin when there is one. */
export function buildCallerHeaders(caller: {
  tenantId: string;
  accountId: string;
  role: string;
  origin?: CallerOrigin;
}): Record<string, string> {
  return {
    'x-tenant-id': caller.tenantId,
    'x-account-id': caller.accountId,
    'x-tenant-role': caller.role,
    ...(caller.origin ? { [LIFTOFF_ORIGIN_HEADER]: JSON.stringify(caller.origin) } : {}),
  };
}

export type CallerResolution =
  | { ok: true; caller: CallerContext }
  | { ok: false; status: number; error: string };

export function resolveCallerFromHeaders(request: FastifyRequest): CallerResolution {
  const tenantId = request.headers['x-tenant-id'] as string | undefined;
  const accountId = request.headers['x-account-id'] as string | undefined;
  const tenantRole = request.headers['x-tenant-role'] as string | undefined;

  if (!tenantId || !accountId || !tenantRole) {
    return {
      ok: false,
      status: 401,
      error: 'Missing required auth headers: x-tenant-id, x-account-id, x-tenant-role',
    };
  }

  const validRoles: TenantMemberRole[] = ['owner', 'admin', 'member', 'viewer'];
  if (!validRoles.includes(tenantRole as TenantMemberRole)) {
    return {
      ok: false,
      status: 401,
      error: `Invalid tenant role: ${tenantRole}`,
    };
  }

  const origin = parseOriginHeader(request.headers[LIFTOFF_ORIGIN_HEADER]);
  const displayName = parseCallerNameHeader(request.headers[CALLER_NAME_HEADER]);

  return {
    ok: true,
    caller: {
      accountId,
      tenantId,
      role: tenantRole as TenantMemberRole,
      ...(displayName ? { displayName } : {}),
      ...(origin ? { origin } : {}),
    },
  };
}
