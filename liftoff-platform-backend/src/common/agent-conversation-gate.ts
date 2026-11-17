// Who may hold a conversation with an agent or a platform assistant.
//
// A viewer may not. The reason is not the message, it is what answering one
// does: an assistant performs workspace actions, and an agent runs work —
// connector calls, browsing, a sandbox, model spend the workspace is billed
// for. A read-only seat that can ask an agent to act is not read-only, it is
// an indirection around the role rule, and the role rule is enforced inside
// the workspace actions rather than at the chat surface precisely because the
// surfaces are many.
//
// READING IS UNAFFECTED. A viewer still opens a workspace's conversations and
// reads every transcript in them; the recall tools are reads and stay offered.
// What is refused is starting a turn, which is the only part that spends or
// changes anything.
//
// WHERE THIS DOES AND DOES NOT REACH. Every surface that resolves a Liftoff
// role: the dashboard's three chat surfaces, the Chief AI Officer, and a
// connected coding tool over MCP. It deliberately does NOT reach a Slack or
// Microsoft Teams direct message, because that path accepts somebody with no
// Liftoff account at all — by design, so a colleague can DM an agent without
// being provisioned — and there is no role to read. That is a known boundary,
// not an oversight: a person who IS a viewer and DMs from Slack is not stopped.
//
// Stopping a turn already in flight is not gated. A viewer cannot start one, so
// there is nothing for them to stop, and refusing it could only ever strand a
// turn somebody else's session began.

import type { Response } from 'express';
import { ROLE_PERMISSIONS, type TenantMemberRole } from '../tenant-members/types';

/** The capability, named once. Owner, admin and member hold it; a viewer does
 *  not. Declared in the role table rather than compared against a role name
 *  here, so a new role gets an answer from the same place every other
 *  capability does. */
export const CONVERSE_PERMISSION = 'converseWithAgents' as const;

export function canConverseWithAgents(role: TenantMemberRole): boolean {
  return ROLE_PERMISSIONS[role]?.[CONVERSE_PERMISSION] === true;
}

/**
 * Refuse a viewer, and say so in their words.
 *
 * Returns true when the response has been sent and the caller must stop, which
 * is the shape the chat routes already use for their own auth failures. Call it
 * where the role becomes known and BEFORE any streaming header is written: the
 * chat streams resolve the caller first for exactly this reason, so a refusal
 * is still an ordinary JSON status rather than an event on an open stream.
 */
export function refusedAsViewer(role: TenantMemberRole, res: Response): boolean {
  if (canConverseWithAgents(role)) return false;
  res.status(403).json({
    error: 'FORBIDDEN',
    // No mechanism, no permission name: what they can do about it.
    message:
      'Your access to this workspace is view only, so you cannot send a message to an agent or an assistant. Ask an owner or an admin of the workspace if you need to.',
  });
  return true;
}
