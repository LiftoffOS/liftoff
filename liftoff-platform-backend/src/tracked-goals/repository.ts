// The goals a person asked to be held onto.
//
// Migration 548. Every read and write is tenant-scoped, as the table is FORCE
// RLS and the policy would otherwise refuse the statement outright rather
// than merely returning nothing.

import { withTenantScope } from '../infrastructure/database';

export interface TrackedGoal {
  id: string;
  accountId: string;
  title: string;
  description: string;
  status: 'active' | 'done';
  createdAt: Date;
  completedAt: Date | null;
}

interface GoalRow {
  id: string;
  account_id: string;
  title: string;
  description: string;
  status: 'active' | 'done';
  created_at: Date;
  completed_at: Date | null;
}

/** The most goals one person may have open at once.
 *
 *  A cap rather than no cap because every one of these is read into the
 *  assistant's context on every turn: a person with two hundred goals would
 *  quietly spend their whole context on them, and the failure would look
 *  like the assistant getting worse at everything else. */
export const MAX_ACTIVE_GOALS = 25;

function mapRow(row: GoalRow): TrackedGoal {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const COLUMNS = 'id, account_id, title, description, status, created_at, completed_at';

/** This person's goals, newest first. Active only unless asked otherwise. */
export async function listGoals(
  tenantId: string,
  accountId: string,
  opts: { includeDone?: boolean } = {},
): Promise<TrackedGoal[]> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<GoalRow>(
      `SELECT ${COLUMNS} FROM tracked_goals
        WHERE tenant_id = $1 AND account_id = $2
          ${opts.includeDone ? '' : "AND status = 'active'"}
        ORDER BY created_at DESC
        LIMIT 100`,
      [tenantId, accountId],
    );
    return rows.map(mapRow);
  });
}

export async function createGoal(input: {
  tenantId: string;
  accountId: string;
  title: string;
  description: string;
}): Promise<TrackedGoal> {
  return withTenantScope(input.tenantId, async (client) => {
    const { rows } = await client.query<GoalRow>(
      `INSERT INTO tracked_goals (tenant_id, account_id, title, description)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [input.tenantId, input.accountId, input.title, input.description],
    );
    return mapRow(rows[0]);
  });
}

/**
 * Finish a goal.
 *
 * Scoped to the person who owns it as well as to the workspace: a goal is
 * one person's commitment, and somebody else's assistant closing it would be
 * the one way a goal can disappear without its owner knowing. Answers null
 * when there is no such active goal of theirs, which is also the answer for
 * one that was already finished.
 */
export async function completeGoal(
  tenantId: string,
  accountId: string,
  goalId: string,
): Promise<TrackedGoal | null> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<GoalRow>(
      `UPDATE tracked_goals
          SET status = 'done', completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1 AND account_id = $2 AND id = $3 AND status = 'active'
        RETURNING ${COLUMNS}`,
      [tenantId, accountId, goalId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

/** How many this person has open, for the cap. */
export async function countActiveGoals(tenantId: string, accountId: string): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tracked_goals
        WHERE tenant_id = $1 AND account_id = $2 AND status = 'active'`,
      [tenantId, accountId],
    );
    return Number(rows[0]?.n ?? 0);
  });
}
