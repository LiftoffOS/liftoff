// Pre-signup guest list (migration 341).
//
// accounts.access_status (migration 304) is the email-level whitelist, but it
// can only be set once the account row exists — i.e. after the person has
// already signed up and been bounced to /request-invite. This table holds the
// same decision made EARLIER, keyed by email, and AccountService.create spends
// it so the matching signup is born 'approved' instead of 'pending'.
//
// Entries are consumed, never deleted: the spent row records who cleared whom
// and which account it let through, and the one-shot semantics stop a
// delete-and-resignup from being auto-granted a second time.

import type { PoolClient } from 'pg';
import { getPool } from '../infrastructure/database';

// Minimal Querier interface: either a pool or a tx client. Both expose
// .query(). Mirrors the local type in ./repository.
type Querier = { query: PoolClient['query'] };

export interface SignupPreapproval {
  id: string;
  email: string;
  note: string | null;
  addedBy: string | null;
  createdAt: Date;
  // NULL while the entry is live. Set at the moment a signup spends it.
  consumedAt: Date | null;
  consumedAccountId: string | null;
}

/**
 * Matching is exact on the normalized address, never fuzzy.
 *
 * Deliberately NOT unwrapping plus-addressing or gmail's dot-insensitivity: a
 * whitelist that grants more than it literally says is a worse failure than
 * one that occasionally misses, because the miss is visible (the person lands
 * on /request-invite and asks) and the over-grant is not.
 */
export function normalizeSignupEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface SignupPreapprovalRow {
  id: string;
  email: string;
  note: string | null;
  added_by: string | null;
  created_at: Date;
  consumed_at: Date | null;
  consumed_account_id: string | null;
}

function mapRow(row: SignupPreapprovalRow): SignupPreapproval {
  return {
    id: row.id,
    email: row.email,
    note: row.note,
    addedBy: row.added_by,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    consumedAccountId: row.consumed_account_id,
  };
}

// Postgres unique-violation. Raised by the partial unique index when two
// admins clear the same address concurrently.
const UNIQUE_VIOLATION = '23505';

export class SignupPreapprovalRepository {
  /**
   * The live entry for an address, if any. Tx-aware so the lookup, the account
   * INSERT and the consume all commit together.
   *
   * No FOR UPDATE: consumeInTx guards on `consumed_at IS NULL`, and
   * accounts.email is UNIQUE, so at most one signup can ever reach this entry.
   */
  async findLiveByEmail(client: Querier, email: string): Promise<SignupPreapproval | null> {
    const result = await client.query<SignupPreapprovalRow>(
      `SELECT id, email, note, added_by, created_at, consumed_at, consumed_account_id
         FROM signup_preapprovals
        WHERE email = $1 AND consumed_at IS NULL`,
      [normalizeSignupEmail(email)],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Spend an entry. Returns false when it was already spent, which makes the
   * call idempotent under a retry rather than re-dating someone else's grant.
   */
  async consumeInTx(client: Querier, id: string, accountId: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE signup_preapprovals
          SET consumed_at = NOW(), consumed_account_id = $2
        WHERE id = $1 AND consumed_at IS NULL`,
      [id, accountId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Put an address on the list. `created: false` means a live entry was
   * already there — adding twice is a no-op, not an error, so a double-click
   * does not 500 and does not silently re-attribute the original decision.
   */
  async add(
    email: string,
    addedBy: string | null,
    note: string | null,
  ): Promise<{ entry: SignupPreapproval; created: boolean }> {
    const pool = getPool();
    const normalized = normalizeSignupEmail(email);
    try {
      const result = await pool.query<SignupPreapprovalRow>(
        `INSERT INTO signup_preapprovals (email, added_by, note)
         VALUES ($1, $2, $3)
         RETURNING id, email, note, added_by, created_at, consumed_at, consumed_account_id`,
        [normalized, addedBy, note],
      );
      return { entry: mapRow(result.rows[0]), created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      const existing = await this.findLiveByEmail(pool as unknown as Querier, normalized);
      // The row can only have vanished between the conflict and this read if
      // it was consumed or revoked in that window; re-raise rather than invent
      // a result.
      if (!existing) throw err;
      return { entry: existing, created: false };
    }
  }

  /** Whole list, live entries first. Backs the operator view. */
  async listAll(): Promise<SignupPreapproval[]> {
    const pool = getPool();
    const result = await pool.query<SignupPreapprovalRow>(
      `SELECT id, email, note, added_by, created_at, consumed_at, consumed_account_id
         FROM signup_preapprovals
        ORDER BY (consumed_at IS NULL) DESC, created_at DESC`,
    );
    return result.rows.map(mapRow);
  }

  /**
   * Take a live entry back off the list. Returns null when it does not exist
   * or has already been spent — a consumed entry is history and stays put; the
   * way to revoke access at that point is the account's own access_status.
   */
  async revoke(id: string): Promise<SignupPreapproval | null> {
    const pool = getPool();
    const result = await pool.query<SignupPreapprovalRow>(
      `DELETE FROM signup_preapprovals
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING id, email, note, added_by, created_at, consumed_at, consumed_account_id`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}
