// Each test here pins one of the six ways this reconciler was broken. Every one
// of them failed silently: the job caught per-group errors, logged `complete`,
// and wrote nothing for months while looking healthy.

const withAdminScopeMock = jest.fn();
const poolQueryMock = jest.fn();
const fetchUsageByApiKeyMock = jest.fn();
const fetchOrgCostUsdMock = jest.fn();
const fetchOrgApiKeysMock = jest.fn().mockResolvedValue([]);
const logWarn = jest.fn();
const logError = jest.fn();
const logInfo = jest.fn();

jest.mock('../../../infrastructure/database', () => ({
  withAdminScope: withAdminScopeMock,
  getPool: () => ({ query: poolQueryMock }),
}));

jest.mock('../anthropic-admin-api', () => ({
  fetchUsageByApiKey: fetchUsageByApiKeyMock,
  fetchOrgCostUsd: fetchOrgCostUsdMock,
  // The reconciler discovers each group's key id from the organisation now, so
  // this has to be mocked or the resolver calls `undefined`. Empty by default:
  // the tests below pin the id they care about with the env var, which still
  // wins, and an empty list is the right answer for the groups they do not.
  fetchOrgApiKeys: fetchOrgApiKeysMock,
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: logInfo, warn: logWarn, error: logError },
}));

/** Capture the internal-totals SQL and answer it with fixed numbers. */
function givenInternal(totals: { cost: string; input: string; output: string }): string[] {
  const seen: string[] = [];
  withAdminScopeMock.mockImplementation(
    async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) =>
      fn({
        query: jest.fn().mockImplementation((sql: string) => {
          seen.push(sql);
          return Promise.resolve({
            rows: [{
              total_cost_usd: totals.cost,
              input_tokens: totals.input,
              output_tokens: totals.output,
            }],
          });
        }),
      }),
  );
  return seen;
}

describe('anthropic billing reconciler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    poolQueryMock.mockResolvedValue({ rows: [] });
    fetchUsageByApiKeyMock.mockResolvedValue(null);
    fetchOrgCostUsdMock.mockResolvedValue(null);
    delete process.env.ANTHROPIC_ADMIN_KEY;
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('ANTHROPIC_API_KEY_ID_')) delete process.env[k];
    }
  });

  it('filters internal totals to provider = anthropic', async () => {
    // Defect 5. Without it this sums every vendor's platform spend and compares
    // the total against Anthropic alone — wrong by however much of the mix is
    // not Anthropic, and by more with each vendor added.
    const seen = givenInternal({ cost: '1.5', input: '100', output: '50' });
    const { runAnthropicBillingReconciler } = await import('../anthropic-billing-reconciler');
    await runAnthropicBillingReconciler();
    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) {
      expect(sql).toContain("provider = 'anthropic'");
    }
  });

  it('writes the columns the table actually has', async () => {
    // Defect 3. The INSERT used to name group_name/computed_at/discrepancy_usd
    // against a table with purpose_group/reconciled_at and no discrepancy_usd,
    // so every statement failed.
    givenInternal({ cost: '1.5', input: '100', output: '50' });
    const { runAnthropicBillingReconciler } = await import('../anthropic-billing-reconciler');
    await runAnthropicBillingReconciler();
    expect(poolQueryMock).toHaveBeenCalled();
    const sql = poolQueryMock.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO anthropic_billing_reconciliation');
    expect(sql).toContain('ON CONFLICT (group_name, date)');
    expect(sql).toContain('internal_input_tokens');
    expect(sql).toContain('token_discrepancy_pct');
  });

  it('records our own side when no admin credential is configured', async () => {
    // Defect 1. The reports need an organisation admin credential; the per-group
    // message keys 401. Missing credential must still produce rows, and must say
    // which secret is missing.
    givenInternal({ cost: '2', input: '10', output: '5' });
    const { runAnthropicBillingReconciler } = await import('../anthropic-billing-reconciler');
    const out = await runAnthropicBillingReconciler();
    expect(out.groupsWritten).toBe(4);
    expect(out.vendorSideMissing).toBe(true);
    expect(fetchUsageByApiKeyMock).not.toHaveBeenCalled();
    const warned = logWarn.mock.calls.map(c => String(c[1])).join(' ');
    expect(warned).toContain('ANTHROPIC_ADMIN_KEY');
  });

  it('never reports success when every group failed', async () => {
    // The meta-defect: `complete` was logged unconditionally, so four straight
    // failures a night read as a healthy job.
    givenInternal({ cost: '1', input: '1', output: '1' });
    poolQueryMock.mockRejectedValue(new Error('column does not exist'));
    const { runAnthropicBillingReconciler } = await import('../anthropic-billing-reconciler');
    const out = await runAnthropicBillingReconciler();
    expect(out.groupsWritten).toBe(0);
    expect(out.groupsFailed).toBe(4);
    expect(logError).toHaveBeenCalled();
    const infoMessages = logInfo.mock.calls.map(c => String(c[1])).join(' ');
    expect(infoMessages).not.toContain('complete');
  });

  it('compares tokens per group against that group own key, not an org total', async () => {
    // Defect 4. One org-wide number used to be compared against each of the four
    // groups, so three of four were wrong by construction. Per-group comparison
    // is on tokens, keyed by the group's own api_key_id.
    process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin-test';
    process.env.ANTHROPIC_API_KEY_ID_AGENT_EXECUTION = 'apikey_agent';
    fetchUsageByApiKeyMock.mockResolvedValue(
      new Map([['apikey_agent', { inputTokens: 900, outputTokens: 100 }]]),
    );
    fetchOrgCostUsdMock.mockResolvedValue(42.5);
    givenInternal({ cost: '1', input: '900', output: '100' });

    const { runAnthropicBillingReconciler } = await import('../anthropic-billing-reconciler');
    await runAnthropicBillingReconciler();

    const agentCall = poolQueryMock.mock.calls.find(c => (c[1] as unknown[])[0] === 'agent_execution');
    expect(agentCall).toBeDefined();
    const params = agentCall![1] as unknown[];
    expect(params[8]).toBe(900);   // anthropic_input_tokens
    expect(params[9]).toBe(100);   // anthropic_output_tokens
    expect(params[10]).toBe(0);    // token_discrepancy_pct — an exact match

    // A group with no configured key id gets NULL vendor tokens rather than
    // another group's numbers.
    const otherCall = poolQueryMock.mock.calls.find(c => (c[1] as unknown[])[0] === 'platform_analytics');
    expect((otherCall![1] as unknown[])[8]).toBeNull();
  });

  it('clamps a discrepancy that would overflow NUMERIC(6,4)', async () => {
    // Defect 6's neighbour: the column tops out at 99.9999, and a tiny vendor
    // total against a large internal one produces a far bigger ratio. An
    // overflow would throw into the same silent per-group catch.
    process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin-test';
    process.env.ANTHROPIC_API_KEY_ID_AGENT_EXECUTION = 'apikey_agent';
    fetchUsageByApiKeyMock.mockResolvedValue(
      new Map([['apikey_agent', { inputTokens: 1, outputTokens: 0 }]]),
    );
    givenInternal({ cost: '1', input: '10000000', output: '0' });
    const { runAnthropicBillingReconciler } = await import('../anthropic-billing-reconciler');
    await runAnthropicBillingReconciler();
    const agentCall = poolQueryMock.mock.calls.find(c => (c[1] as unknown[])[0] === 'agent_execution');
    expect((agentCall![1] as unknown[])[10]).toBeLessThanOrEqual(99.9999);
  });

  it('passes null, not a number, when there is nothing to compare', async () => {
    // Defect 6. migration 133 had discrepancy_pct NOT NULL while the code passes
    // null whenever the vendor side is absent, so the insert would still have
    // failed after the column names were fixed. 421 drops the constraint; this
    // pins that null is what actually gets sent.
    givenInternal({ cost: '1', input: '5', output: '5' });
    const { runAnthropicBillingReconciler } = await import('../anthropic-billing-reconciler');
    await runAnthropicBillingReconciler();
    const params = poolQueryMock.mock.calls[0][1] as unknown[];
    expect(params[5]).toBeNull();   // discrepancy_pct
    expect(params[10]).toBeNull();  // token_discrepancy_pct
    expect(params[3]).toBe(-1);     // anthropic_cost_usd sentinel
  });
});
