import { withTenantScope } from '../infrastructure/database';
import { getHumanTaskCounts } from '../human-feedback/human-task-counts';
import type { PersonWithAssignments, AgentAssignment, AgentOrigin } from './types';

export const personAssignmentsService = {
  // Default assignee for a new feedback request on an internal agent: the earliest ACTIVE
  // assignee bound to that agent. Joining tenant_members (membership is presence-based)
  // excludes anyone who has left the tenant; the (created_at, id) order is deterministic
  // under tied timestamps.
  async getDefaultAssignee(tenantId: string, agentId: string): Promise<string | null> {
    return withTenantScope(tenantId, async (client) => {
      const r = await client.query<{ account_id: string }>(
        `SELECT pa.account_id
           FROM person_agent_assignments pa
           JOIN tenant_members tm
             ON tm.tenant_id = pa.tenant_id AND tm.account_id = pa.account_id
          WHERE pa.tenant_id = $1 AND pa.agent_id = $2
            AND pa.agent_origin = 'internal' AND pa.deleted_at IS NULL
          ORDER BY pa.created_at ASC, pa.id ASC
          LIMIT 1`,
        [tenantId, agentId],
      );
      return r.rows[0]?.account_id ?? null;
    });
  },

  async listPersonnelWithAssignments(tenantId: string): Promise<PersonWithAssignments[]> {
    // tenant_members / accounts / person_agent_assignments / internal_agents /
    // external_agents are platform-backend-owned (RLS-on, migrations 095 + 200)
    // and queried under withTenantScope.
    const membersPromise = withTenantScope(tenantId, (client) =>
      client.query(
        `SELECT
          tm.id AS person_id,
          tm.account_id,
          a.first_name,
          a.last_name,
          a.email,
          tm.joined_at,
          COALESCE(
            json_agg(
              json_build_object(
                'agentId', pa.agent_id,
                'agentType', pa.agent_origin,
                'agentName', COALESCE(ia.role, ea.name)
              )
            ) FILTER (WHERE pa.id IS NOT NULL AND (ia.id IS NOT NULL OR ea.id IS NOT NULL)),
            '[]'
          ) AS assignments
        FROM tenant_members tm
        JOIN accounts a ON tm.account_id = a.id
        LEFT JOIN person_agent_assignments pa
          ON pa.account_id = tm.account_id AND pa.tenant_id = tm.tenant_id AND pa.deleted_at IS NULL
        LEFT JOIN internal_agents ia
          ON pa.agent_id = ia.id AND pa.agent_origin = 'internal'
        LEFT JOIN external_agents ea
          ON pa.agent_id = ea.id AND pa.agent_origin = 'external'
        WHERE tm.tenant_id = $1
        GROUP BY tm.id, tm.account_id, a.first_name, a.last_name, a.email,
                 tm.joined_at
        ORDER BY a.first_name, a.last_name`,
        [tenantId],
      ),
    );

    // Trailing 30-day per-account human task counts. Unified across the
    // platform — same definition powers the /insights Human Workforce
    // Activity chart. See human-feedback/human-task-counts.ts.
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    // The two sources are independent — run them concurrently.
    const [result, taskCounts] = await Promise.all([
      membersPromise,
      getHumanTaskCounts(tenantId, start, end),
    ]);

    return result.rows.map(row => {
      const counts = taskCounts[row.account_id as string];
      const tasks30d = counts ? counts.approvalCount + counts.correctionCount : 0;
      return {
        accountId: row.account_id,
        personId: row.person_id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        onboardStatus: null,
        joinedAt: row.joined_at,
        costPerMonth: null,
        tasks30d,
        isAssignable: true,
        assignments: row.assignments as AgentAssignment[],
      };
    });
  },

  async updateAssignmentsForPerson(
    tenantId: string,
    accountId: string,
    assignments: Array<{ agentId: string; agentType: AgentOrigin }>,
    createdBy: string | null
  ): Promise<{ added: number; removed: number }> {
    // withTenantScope wraps the entire callback in a single transaction with
    // app.current_tenant_id set. The wrapper opens BEGIN, runs the callback,
    // COMMITs on return, ROLLBACKs on throw. We rely on that — no inner
    // BEGIN/COMMIT/ROLLBACK (which would nest and break the wrapper's tx).
    return withTenantScope(tenantId, async (client) => {
      // Validate accountId is a member of this tenant
      const personCheck = await client.query(
        `SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND account_id = $2`,
        [tenantId, accountId]
      );
      if (personCheck.rows.length === 0) {
        throw Object.assign(new Error('Person not found in tenant'), { statusCode: 404 });
      }

      // Validate each agentId exists in tenant and is not archived
      if (assignments.length > 0) {
        const internalIds = assignments.filter(a => a.agentType === 'internal').map(a => a.agentId);
        const externalIds = assignments.filter(a => a.agentType === 'external').map(a => a.agentId);

        if (internalIds.length > 0) {
          const iaResult = await client.query(
            `SELECT id FROM internal_agents WHERE id = ANY($1) AND tenant_id = $2 AND status != 'archived'`,
            [internalIds, tenantId]
          );
          const foundIds = new Set(iaResult.rows.map(r => r.id));
          const missing = internalIds.filter(id => !foundIds.has(id));
          if (missing.length > 0) {
            throw Object.assign(new Error(`Invalid internal agent IDs: ${missing.join(', ')}`), { statusCode: 400 });
          }
        }

        if (externalIds.length > 0) {
          const eaResult = await client.query(
            `SELECT id FROM external_agents WHERE id = ANY($1) AND tenant_id = $2 AND deleted_at IS NULL`,
            [externalIds, tenantId]
          );
          const foundIds = new Set(eaResult.rows.map(r => r.id));
          const missing = externalIds.filter(id => !foundIds.has(id));
          if (missing.length > 0) {
            throw Object.assign(new Error(`Invalid external agent IDs: ${missing.join(', ')}`), { statusCode: 400 });
          }
        }
      }

      // Lock existing active assignments for this person
      const existingResult = await client.query(
        `SELECT id, agent_id, agent_origin FROM person_agent_assignments
         WHERE tenant_id = $1 AND account_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [tenantId, accountId]
      );
      const existing = existingResult.rows;

      // Compute diff
      const desiredSet = new Set(assignments.map(a => `${a.agentId}:${a.agentType}`));
      const existingSet = new Set(existing.map((r: { agent_id: string; agent_origin: string }) => `${r.agent_id}:${r.agent_origin}`));

      // Soft-delete removed assignments
      const toRemove = existing.filter((r: { agent_id: string; agent_origin: string }) =>
        !desiredSet.has(`${r.agent_id}:${r.agent_origin}`)
      );
      if (toRemove.length > 0) {
        await client.query(
          `UPDATE person_agent_assignments SET deleted_at = NOW() WHERE id = ANY($1)`,
          [toRemove.map((r: { id: string }) => r.id)]
        );
      }

      // Insert new assignments
      const toAdd = assignments.filter(a => !existingSet.has(`${a.agentId}:${a.agentType}`));
      for (const assignment of toAdd) {
        await client.query(
          `INSERT INTO person_agent_assignments (tenant_id, account_id, agent_id, agent_origin, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, accountId, assignment.agentId, assignment.agentType, createdBy]
        );
      }

      return { added: toAdd.length, removed: toRemove.length };
    });
  },

};
