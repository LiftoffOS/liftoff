// The person a workspace action is performed AS, and where they acted from.
//
// One shape for every caller: the dashboard routes, Liftoff, the Insights
// Manager, the Chief AI Officer (over the internal route), Slack, Teams, and
// the MCP chat worker on behalf of a coding tool. The role is read from
// tenant_members on every resolution and never defaulted: a person removed or
// demoted since the turn started must not complete a write with the authority
// they had when it began. Null means refuse.
//
// `surface` says which product surface the action came from; `via` says the
// assistant turn itself came through somewhere else — a coding tool
// (`'mcp'`, with `client` the tool's name and `credentialId` the anchor token
// id) or a chat workspace (`'slack'` / `'teams'`, with `client` the workspace
// id and no credential of its own). All of it lands on the audit row so the
// workspace feed can say who did what, from where.

import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import type { TenantMemberRole } from '../tenant-members/types';
import { hasPermission, type Permission } from './permissions';

export type ActorSurface = 'dashboard' | 'liftoff' | 'caio' | 'insights' | 'slack' | 'teams';

/** Where an assistant turn was started from, when not the dashboard. */
export type ActorVia = 'mcp' | 'slack' | 'teams';

export interface ActorOrigin {
  via: ActorVia;
  client: string;
  credentialId: string;
}

export interface Actor {
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
  displayName: string;
  surface: ActorSurface;
  via?: ActorVia;
  client?: string;
  credentialId?: string;
  /** NOBODY IS THERE.
   *
   *  True for an answer-mode turn: a colleague a team brought in for a
   *  question, or a team running with no chat and no person. The account this
   *  actor names is the workspace's own, and the turn is offered no mutating
   *  tool — but a tool can still be reached by name, so an action that needs a
   *  person to DO something (open a link, enter a key) reads this and refuses
   *  rather than producing something nobody will act on. */
  unattended?: boolean;
}

/** Thrown by requirePermission; the route adapters map it to 403 and the tool
 *  dispatcher relays its message to the model. */
export class PermissionDenied extends Error {
  readonly status = 403;
  readonly permission: Permission;
  constructor(permission: Permission, role: string) {
    super(`This action needs the ${permission} permission; the ${role} role does not have it`);
    this.name = 'PermissionDenied';
    this.permission = permission;
  }
}

const accountService = new AccountService();

/** Resolve the actor for an account in a tenant. Membership is read now, not
 *  remembered from an earlier call; a missing membership answers null and the
 *  caller refuses. The display name comes from the account (first/last, email
 *  fallback) unless the caller already holds it. */
export async function resolveActor(p: {
  tenantId: string;
  accountId: string;
  surface: ActorSurface;
  via?: ActorVia;
  client?: string;
  credentialId?: string;
  displayName?: string;
  /** Carried through, not re-derived. This is a property of the TURN — an
   *  answer-mode turn with nobody present — and re-reading membership says
   *  nothing about it. Dropping it here is how a refusal that only a mutating
   *  tool can make would never fire: the dispatcher re-resolves the actor
   *  before every write, so whatever it does not copy is gone by the time the
   *  tool runs. */
  unattended?: boolean;
}): Promise<Actor | null> {
  const membership = await tenantMembersService.getMembership(p.tenantId, p.accountId);
  if (!membership) return null;

  let displayName = p.displayName ?? '';
  if (p.displayName === undefined) {
    const account = await accountService.getById(p.accountId);
    if (account) {
      const fullName = [account.firstName, account.lastName].filter(Boolean).join(' ').trim();
      displayName = fullName || account.email;
    }
  }

  return {
    tenantId: p.tenantId,
    accountId: p.accountId,
    role: membership.role,
    displayName,
    surface: p.surface,
    ...(p.via ? { via: p.via } : {}),
    ...(p.client ? { client: p.client } : {}),
    ...(p.credentialId ? { credentialId: p.credentialId } : {}),
    ...(p.unattended ? { unattended: true } : {}),
  };
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!hasPermission(actor.role, permission)) {
    throw new PermissionDenied(permission, actor.role);
  }
}
