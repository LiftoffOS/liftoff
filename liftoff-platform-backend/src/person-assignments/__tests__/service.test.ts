import { personAssignmentsService } from '../service';

// Mock the database pool. listPersonnelWithAssignments + updateAssignmentsForPerson
// both run under withTenantScope; the mock fake-client delegates query() to
// mockClientQuery so the per-call mockResolvedValueOnce chain still works.
const mockClientQuery = jest.fn();
const mockQuery = mockClientQuery;

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(
    async (
      _tenantId: string,
      fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
    ) => fn({ query: mockClientQuery }),
  ),
}));

// Human task counts (HITL + corrections) are looked up via the unified
// helper — stub it so tests don't hit Postgres or the tenant runtime.
jest.mock('../../human-feedback/human-task-counts', () => ({
  getHumanTaskCounts: jest.fn().mockResolvedValue({}),
}));

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const AGENT_ID_1 = '00000000-0000-0000-0000-000000000100';
const AGENT_ID_2 = '00000000-0000-0000-0000-000000000200';
const CREATED_BY = '00000000-0000-0000-0000-000000000099';

describe('personAssignmentsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listPersonnelWithAssignments', () => {
    it('returns personnel with assignments mapped correctly', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            person_id: 'tm_001',
            account_id: ACCOUNT_ID,
            first_name: 'Jane',
            last_name: 'Smith',
            email: 'jane@test.com',
            joined_at: '2024-01-15T00:00:00Z',
            assignments: [{ agentId: AGENT_ID_1, agentType: 'internal', agentName: 'Support Agent' }],
          },
        ],
      });
      const result = await personAssignmentsService.listPersonnelWithAssignments(TENANT_ID);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        accountId: ACCOUNT_ID,
        personId: 'tm_001',
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@test.com',
        onboardStatus: null,
        joinedAt: '2024-01-15T00:00:00Z',
        costPerMonth: null,
        tasks30d: 0,
        isAssignable: true,
        assignments: [{ agentId: AGENT_ID_1, agentType: 'internal', agentName: 'Support Agent' }],
      });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('tenant_members'), [TENANT_ID]);
    });

    it('SQL excludes mcp_tokens and the payroll tables', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await personAssignmentsService.listPersonnelWithAssignments(TENANT_ID);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).not.toContain('mcp_tokens');
      expect(sql).not.toContain('company_payroll_settings');
      expect(sql).not.toContain('company_employees');
      expect(sql).not.toContain('company_contractors');
      expect(sql).toContain('internal_agents');
      expect(sql).toContain('external_agents');
    });

    it('returns empty array when no members exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await personAssignmentsService.listPersonnelWithAssignments(TENANT_ID);
      expect(result).toEqual([]);
    });
  });

  describe('updateAssignmentsForPerson', () => {
    it('adds assignments where none exist', async () => {
      mockClientQuery.mockReset();
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // tenant_members check
        .mockResolvedValueOnce({ rows: [{ id: AGENT_ID_1 }] }) // agent validation
        .mockResolvedValueOnce({ rows: [] }) // lock existing
        .mockResolvedValueOnce({}); // INSERT

      const result = await personAssignmentsService.updateAssignmentsForPerson(
        TENANT_ID, ACCOUNT_ID,
        [{ agentId: AGENT_ID_1, agentType: 'internal' }],
        CREATED_BY
      );

      expect(result.added).toBe(1);
      expect(result.removed).toBe(0);
      // Verify tenant_members check is the FIRST query inside the scope
      expect(mockClientQuery).toHaveBeenNthCalledWith(1,
        expect.stringContaining('tenant_members'),
        [TENANT_ID, ACCOUNT_ID]
      );
    });

    it('removes all assignments when empty array sent', async () => {
      mockClientQuery.mockReset();
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // tenant_members check
        .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: AGENT_ID_1, agent_origin: 'internal' }] }) // lock existing
        .mockResolvedValueOnce({}); // UPDATE (soft-delete)

      const result = await personAssignmentsService.updateAssignmentsForPerson(
        TENANT_ID, ACCOUNT_ID, [], CREATED_BY
      );

      expect(result.added).toBe(0);
      expect(result.removed).toBe(1);
    });

    it('rejects accountId not belonging to tenant with 404', async () => {
      mockClientQuery.mockReset();
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }); // tenant_members check - not found

      await expect(
        personAssignmentsService.updateAssignmentsForPerson(
          TENANT_ID, ACCOUNT_ID, [], CREATED_BY
        )
      ).rejects.toMatchObject({ message: 'Person not found in tenant', statusCode: 404 });
    });

    it('rejects non-existent internal agentId with 400', async () => {
      mockClientQuery.mockReset();
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // tenant_members check
        .mockResolvedValueOnce({ rows: [] }); // agent validation - not found

      await expect(
        personAssignmentsService.updateAssignmentsForPerson(
          TENANT_ID, ACCOUNT_ID,
          [{ agentId: AGENT_ID_1, agentType: 'internal' }],
          CREATED_BY
        )
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects non-existent external agentId with 400', async () => {
      mockClientQuery.mockReset();
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // tenant_members check
        .mockResolvedValueOnce({ rows: [] }); // external agent validation - not found

      await expect(
        personAssignmentsService.updateAssignmentsForPerson(
          TENANT_ID, ACCOUNT_ID,
          [{ agentId: AGENT_ID_2, agentType: 'external' }],
          CREATED_BY
        )
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('handles mixed add/remove in single call', async () => {
      mockClientQuery.mockReset();
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // tenant_members check
        .mockResolvedValueOnce({ rows: [{ id: AGENT_ID_2 }] }) // validate new agent
        .mockResolvedValueOnce({ rows: [
          { id: 'assignment-1', agent_id: AGENT_ID_1, agent_origin: 'internal' },
        ]}) // lock existing - has AGENT_ID_1
        .mockResolvedValueOnce({}) // UPDATE soft-delete AGENT_ID_1
        .mockResolvedValueOnce({}); // INSERT AGENT_ID_2

      const result = await personAssignmentsService.updateAssignmentsForPerson(
        TENANT_ID, ACCOUNT_ID,
        [{ agentId: AGENT_ID_2, agentType: 'internal' }],
        CREATED_BY
      );

      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
    });

    it('is idempotent when same assignments sent', async () => {
      mockClientQuery.mockReset();
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // tenant_members check
        .mockResolvedValueOnce({ rows: [{ id: AGENT_ID_1 }] }) // validate agent
        .mockResolvedValueOnce({ rows: [
          { id: 'assignment-1', agent_id: AGENT_ID_1, agent_origin: 'internal' },
        ]}); // lock existing - already assigned (no INSERT, no UPDATE)

      const result = await personAssignmentsService.updateAssignmentsForPerson(
        TENANT_ID, ACCOUNT_ID,
        [{ agentId: AGENT_ID_1, agentType: 'internal' }],
        CREATED_BY
      );

      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });
  });

  describe('setDelegateGrant', () => {
  });
});
