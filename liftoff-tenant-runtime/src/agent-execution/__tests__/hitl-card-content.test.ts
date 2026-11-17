// hitl-card-content unit tests. The deterministic fallbacks are pinned exactly; the
// small-model call is MOCKED so no test depends on generated prose. Covers the
// security (frameUntrusted-wrapped + secret-scrubbed args), attribution, narration-wins
// Why, timeout/failure fallback, and the flag + generate-once guards.

const mockComplete = jest.fn();
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: (...a: unknown[]) => mockComplete(...a) } }));

const mockFrameUntrusted = jest.fn((_src: string, content: string) => `FRAMED:${content}`);
jest.mock('../../workspace/untrusted-content-wrapper', () => ({
  frameUntrusted: (...a: unknown[]) => mockFrameUntrusted(...(a as [string, string])),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  buildActionFallback, buildDetailLine, generateApprovalSummary, maybeGenerateApprovalSummary,
} from '../hitl-card-content';

const ATTR = { tenantId: 't1', agentId: 'a1', invocationId: 'i1' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HITL_GENERIC_CARD_ENABLED;
});

describe('buildActionFallback (deterministic)', () => {
  it('humanizes a connector tool: "Github: merge pull request"', () => {
    expect(buildActionFallback([{ name: 'github-ab12__merge_pull_request', input: {} }]))
      .toBe('Github: merge pull request');
  });
  it('strips the mcp__ transport prefix identically', () => {
    expect(buildActionFallback([{ name: 'mcp__github-ab12__merge_pull_request', input: {} }]))
      .toBe('Github: merge pull request');
  });
  it('lists every call up to 3, then "+N more"', () => {
    const calls = Array.from({ length: 5 }, (_, i) => ({ name: `acme__do_${i}`, input: {} }));
    const out = buildActionFallback(calls);
    expect(out).toContain('+2 more');
    expect(out.split(';').length).toBe(4); // 3 humanized + the "+2 more" segment
  });
  it('a bare built-in tool has no connector prefix', () => {
    expect(buildActionFallback([{ name: 'memory_save', input: {} }])).toBe('memory save');
  });
  it('is never empty', () => {
    expect(buildActionFallback([]).length).toBeGreaterThan(0);
  });
});

describe('buildDetailLine (deterministic trust anchor)', () => {
  it('renders connector · action + the key arg', () => {
    const out = buildDetailLine([{ name: 'salesforce__update_record', input: { object: 'Account', id: '0015x' } }]);
    expect(out).toContain('salesforce · update_record');
    expect(out).toContain('id 0015x');
  });
  it('redacts secret-bearing args', () => {
    const out = buildDetailLine([{ name: 'stripe__create_refund', input: { api_key: 'sk-secret', title: 'refund' } }]);
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('title refund');
  });
  it('hard-caps the assembled line', () => {
    const out = buildDetailLine([{ name: 'x__do', input: { title: 'z'.repeat(1000) } }]);
    expect(out.length).toBeLessThanOrEqual(400);
  });
});

describe('generateApprovalSummary (model mocked)', () => {
  it('uses the model ACTION + narration WHY (no model why when narration present)', async () => {
    mockComplete.mockResolvedValue({ content: 'ACTION: Merge PR #12 in acme/site' });
    const r = await generateApprovalSummary(
      [{ name: 'github__merge_pull_request', input: { pull_number: 12 } }],
      'Merging because CI passed and both reviews approved',
      ATTR,
    );
    expect(r.action).toBe('Merge PR #12 in acme/site');
    expect(r.why).toBe('Merging because CI passed and both reviews approved');
    expect(r.detail).toContain('github · merge_pull_request');
  });
  it('wraps args with frameUntrusted and passes the attribution context', async () => {
    mockComplete.mockResolvedValue({ content: 'ACTION: do it' });
    await generateApprovalSummary([{ name: 'x__do', input: { foo: 'bar' } }], undefined, ATTR);
    expect(mockFrameUntrusted).toHaveBeenCalled();
    const call = mockComplete.mock.calls[0];
    expect(call[1]).toBeUndefined(); // explicitProvider
    expect(call[2]).toMatchObject({ tenantId: 't1', agentId: 'a1', purpose: 'hitl_card_summary', invocationId: 'i1' });
    // The request uses the small tier, never a hardcoded model id.
    expect(call[0]).toMatchObject({ tier: 'small' });
    expect(call[0].model).toBeUndefined();
  });
  it('scrubs a secret arg BEFORE the model sees it', async () => {
    mockComplete.mockResolvedValue({ content: 'ACTION: do it' });
    await generateApprovalSummary([{ name: 'x__do', input: { token: 'sk-xyz' } }], undefined, ATTR);
    const framedArg = mockFrameUntrusted.mock.calls[0][1];
    expect(framedArg).not.toContain('sk-xyz');
    expect(framedArg).toContain('[redacted]');
  });
  it('falls back deterministically when the model throws', async () => {
    mockComplete.mockRejectedValue(new Error('boom'));
    const r = await generateApprovalSummary([{ name: 'github__merge_pull_request', input: {} }], undefined, ATTR);
    expect(r.action).toBe('Github: merge pull request');
    expect(r.why).toBeNull();
  });
});

describe('maybeGenerateApprovalSummary (flag + generate-once guards)', () => {
  it('returns undefined and makes NO model call when the flag is off', async () => {
    const r = await maybeGenerateApprovalSummary({
      calls: [{ name: 'x__do', input: {} }], attribution: ATTR, alreadyExists: async () => false,
    });
    expect(r).toBeUndefined();
    expect(mockComplete).not.toHaveBeenCalled();
  });
  it('returns undefined (no second model call) when the approval already exists (re-fire)', async () => {
    process.env.HITL_GENERIC_CARD_ENABLED = 'true';
    const r = await maybeGenerateApprovalSummary({
      calls: [{ name: 'x__do', input: {} }], attribution: ATTR, alreadyExists: async () => true,
    });
    expect(r).toBeUndefined();
    expect(mockComplete).not.toHaveBeenCalled();
  });
  it('generates when the flag is on and the approval is new', async () => {
    process.env.HITL_GENERIC_CARD_ENABLED = 'true';
    mockComplete.mockResolvedValue({ content: 'ACTION: do it' });
    const r = await maybeGenerateApprovalSummary({
      calls: [{ name: 'x__do', input: {} }], attribution: ATTR, alreadyExists: async () => false,
    });
    expect(r?.action).toBe('do it');
  });
});
