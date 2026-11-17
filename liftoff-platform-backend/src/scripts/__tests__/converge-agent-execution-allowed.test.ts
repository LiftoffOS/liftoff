// The property under test is which tenants the sweep will WRITE to.
//
// Getting that wrong is not loud. The script it replaces guarded on
// `tenants.status === 'active'` as a proxy for "already repaired", while the
// thing it repaired was `entitlements.agent_execution_allowed` — so it skipped
// every tenant that was active-but-not-allowed, which is the entire population
// it existed for. Three tenants stayed unfixed for five months and the run
// reported success. These tests pin the selection itself.

const withAdminScopeMock = jest.fn();
const enableAgentExecutionMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: withAdminScopeMock,
  initDatabase: jest.fn(),
  closePools: jest.fn(),
}));

jest.mock('../../entitlements/service', () => ({
  EntitlementService: jest.fn().mockImplementation(() => ({
    enableAgentExecution: enableAgentExecutionMock,
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

interface Candidate {
  tenant_id: string;
  name: string | null;
  email: string | null;
  billing_provisioned: boolean;
}

/** Feed the sweep a candidate set and return what it did. */
function givenCandidates(rows: Candidate[]): void {
  withAdminScopeMock.mockImplementation(
    async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) =>
      fn({ query: jest.fn().mockResolvedValue({ rows }) }),
  );
}

const PROVISIONED: Candidate = {
  tenant_id: 'b2137784-e318-428d-9051-b3ee5f461cde',
  name: 'Alex',
  email: 'owner@example.com',
  billing_provisioned: true,
};
const NO_BILLING_ROW: Candidate = {
  tenant_id: '18fe45d3-0000-4000-8000-000000000000',
  name: 'Never provisioned',
  email: 'other@example.com',
  billing_provisioned: false,
};

describe('converge-agent-execution-allowed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DRY_RUN;
    enableAgentExecutionMock.mockResolvedValue({ agentExecutionAllowed: true });
  });

  it('enables a tenant whose account has a billing_controls row', async () => {
    givenCandidates([PROVISIONED]);
    const { runConvergeAgentExecution } = await import('../converge-agent-execution-allowed');
    const out = await runConvergeAgentExecution();
    expect(enableAgentExecutionMock).toHaveBeenCalledWith(PROVISIONED.tenant_id);
    expect(out.enabled).toEqual([PROVISIONED.tenant_id]);
    expect(out.failed).toEqual([]);
  });

  it('does NOT write when the account has no billing_controls row', async () => {
    // Absence is ambiguous — internal/exempt accounts have no row either — so
    // it must decide nothing. A sweep that treated absence as "not provisioned"
    // would be equally wrong in the other direction and would silently skip
    // every exempt account.
    givenCandidates([NO_BILLING_ROW]);
    const { runConvergeAgentExecution } = await import('../converge-agent-execution-allowed');
    const out = await runConvergeAgentExecution();
    expect(enableAgentExecutionMock).not.toHaveBeenCalled();
    expect(out.skippedNoBillingControls).toEqual([NO_BILLING_ROW.tenant_id]);
    expect(out.enabled).toEqual([]);
  });

  it('reports the skipped tenant rather than dropping it', async () => {
    // The guard on the guard: a skip that vanishes from the result is
    // indistinguishable from a tenant that was never a candidate, which is how
    // drift stays invisible.
    givenCandidates([PROVISIONED, NO_BILLING_ROW]);
    const { runConvergeAgentExecution } = await import('../converge-agent-execution-allowed');
    const out = await runConvergeAgentExecution();
    expect(out.enabled).toEqual([PROVISIONED.tenant_id]);
    expect(out.skippedNoBillingControls).toEqual([NO_BILLING_ROW.tenant_id]);
  });

  it('DRY_RUN reports the same set without writing', async () => {
    process.env.DRY_RUN = '1';
    givenCandidates([PROVISIONED]);
    const { runConvergeAgentExecution } = await import('../converge-agent-execution-allowed');
    const out = await runConvergeAgentExecution();
    expect(enableAgentExecutionMock).not.toHaveBeenCalled();
    expect(out.enabled).toEqual([PROVISIONED.tenant_id]);
  });

  it('one failure does not strand the rest, and is surfaced', async () => {
    const second = { ...PROVISIONED, tenant_id: 'adfc44b7-5179-43f3-a228-8cd035f1c7b7' };
    givenCandidates([PROVISIONED, second]);
    enableAgentExecutionMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ agentExecutionAllowed: true });
    const { runConvergeAgentExecution } = await import('../converge-agent-execution-allowed');
    const out = await runConvergeAgentExecution();
    expect(out.failed).toEqual([PROVISIONED.tenant_id]);
    expect(out.enabled).toEqual([second.tenant_id]);
  });

  it('selects on the entitlement flag, and an active tenant is a candidate', async () => {
    // The replaced script's defect, stated as a property. It treated
    // `status === 'active'` as evidence the tenant was already repaired; here
    // active is a REQUIREMENT of candidacy, and the flag is what is selected
    // on. Asserted against the SQL because there is no other place the
    // distinction lives.
    let sql = '';
    withAdminScopeMock.mockImplementation(
      async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) =>
        fn({
          query: jest.fn().mockImplementation((text: string) => {
            sql = text;
            return Promise.resolve({ rows: [] });
          }),
        }),
    );
    const { runConvergeAgentExecution } = await import('../converge-agent-execution-allowed');
    await runConvergeAgentExecution();
    expect(sql).toContain('agent_execution_allowed = FALSE');
    expect(sql).toContain("t.status = 'active'");
  });
});
