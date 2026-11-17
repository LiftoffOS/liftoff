// support_delegation_sessions data access.
//
// Platform-global table (docs/rls.md): it is account-scoped like `accounts` and
// `staff_roles`, never tenant-scoped, so it lives on the default pool and needs
// no RLS wrapper.

import { getPool } from '../infrastructure/database';
import type { DelegationSessionRow } from './types';

export interface CreateSessionInput {
  ticketHash: string;
  actorAccountId: string;
  targetAccountId: string;
  reason: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreatedSession {
  id: string;
}

export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const result = await getPool().query<CreatedSession>(
    `INSERT INTO support_delegation_sessions
       (ticket_hash, actor_account_id, target_account_id, reason, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5::inet, $6)
     RETURNING id`,
    [
      input.ticketHash,
      input.actorAccountId,
      input.targetAccountId,
      input.reason,
      input.ipAddress,
      input.userAgent,
    ],
  );
  return result.rows[0];
}

/**
 * The middleware's per-request lookup.
 *
 * Joins both accounts in one query rather than three round trips, because this
 * runs on EVERY request of a delegated session. Returns the row whatever its
 * state, so the caller can log each kind of rejection for what it is.
 */
export async function findByTicketHash(ticketHash: string): Promise<DelegationSessionRow | null> {
  const result = await getPool().query<DelegationSessionRow>(
    `SELECT s.id,
            s.actor_account_id,
            s.target_account_id,
            s.ended_at,
            actor.firebase_uid       AS actor_firebase_uid,
            actor.email              AS actor_email,
            actor.is_platform_admin  AS actor_is_platform_admin,
            target.firebase_uid      AS target_firebase_uid,
            target.email             AS target_email,
            target.is_platform_admin AS target_is_platform_admin
       FROM support_delegation_sessions s
       JOIN accounts actor  ON actor.id  = s.actor_account_id
       JOIN accounts target ON target.id = s.target_account_id
      WHERE s.ticket_hash = $1`,
    [ticketHash],
  );
  return result.rows[0] ?? null;
}

/** Ends a session early. Idempotent: ending an ended session is a no-op, so a
 *  double click on Exit does not 500. */
export async function endSession(sessionId: string, endedBy: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE support_delegation_sessions
        SET ended_at = NOW(), ended_by = $2
      WHERE id = $1 AND ended_at IS NULL`,
    [sessionId, endedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface SessionListRow {
  id: string;
  target_email: string | null;
  reason: string;
  created_at: Date;
  ended_at: Date | null;
}

/** Sessions this admin has opened, newest first. Deliberately scoped to the
 *  calling admin: a cross-admin view is an audit question and belongs in the
 *  audit log, not in the tool that hands out access. */
export async function listForActor(actorAccountId: string, limit = 50): Promise<SessionListRow[]> {
  const result = await getPool().query<SessionListRow>(
    `SELECT s.id, target.email AS target_email, s.reason, s.created_at, s.ended_at
       FROM support_delegation_sessions s
       JOIN accounts target ON target.id = s.target_account_id
      WHERE s.actor_account_id = $1
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [actorAccountId, limit],
  );
  return result.rows;
}
