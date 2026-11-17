// The tool an agent actually calls, end to end: catalog → handler → ledger.
//
// Wired-at-one-end is this estate's dominant defect class — a feature connected
// at only one end passes lint, typecheck and its own unit tests while never
// running. The memory API sat unmounted for months; chat memory retrieve/save
// was dead for four; the code-mode bridge was built and undiscoverable. So this
// exercises the real dispatch path rather than calling the handler directly:
// a tool absent from the catalog, or missing its case in the switch, fails here.

const mockFind = jest.fn();

jest.mock('../../action-ledger/repository', () => ({
  ActionRepository: jest.fn().mockImplementation(() => ({
    findPriorActionsOnTarget: (...a: unknown[]) => mockFind(...a),
  })),
  CompensationRepository: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { executeStandardTool, type StandardToolContext } from '../standard-tool-handler';
import { getStandardTool, isStandardTool } from '../standard-tools';

const CTX: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { readableLayers: [], writableLayers: [] },
  traceId: 'trace-abc',
};

const GITHUB_PR = { owner: 'acme', repo: 'billing', pull_number: 17 };

describe('have_i_acted_on is reachable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is in the catalog the model is shown', () => {
    expect(isStandardTool('have_i_acted_on')).toBe(true);
    expect(getStandardTool('have_i_acted_on')).toBeDefined();
  });

  it('dispatches to a handler rather than the unhandled-tool sentinel', async () => {
    mockFind.mockResolvedValueOnce([]);
    const result = await executeStandardTool('have_i_acted_on', {
      connector: 'github', target: GITHUB_PR,
    }, CTX);
    // null is what executeStandardTool returns for a name it has no case for —
    // the exact shape that made 116 dispatchable tools fail as "no handler
    // registered for standard tool".
    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
  });
});

describe('have_i_acted_on answers "have I already reviewed this PR?"', () => {
  beforeEach(() => jest.clearAllMocks());

  it('derives the same key the writer records, so a lookup can match', async () => {
    // The whole correctness argument. If the lookup built its key
    // independently it would drift from the writer, match nothing, and answer
    // "not_acted" with complete confidence for work that certainly happened.
    mockFind.mockResolvedValueOnce([]);
    await executeStandardTool('have_i_acted_on', { connector: 'github', target: GITHUB_PR }, CTX);
    expect(mockFind.mock.calls[0][0]).toMatchObject({
      targetRef: 'github:acme/billing#17',
    });
  });

  it('accepts the bound alias from a tool name, not just the bare type', async () => {
    // The agent sees `github-7d07a896__create_review`, so `github-7d07a896` is
    // the connector string it has to hand. It must resolve to the same key.
    mockFind.mockResolvedValueOnce([]);
    await executeStandardTool('have_i_acted_on', {
      connector: 'github-7d07a896', target: GITHUB_PR,
    }, CTX);
    expect(mockFind.mock.calls[0][0]).toMatchObject({
      targetRef: 'github:acme/billing#17',
    });
  });

  it('reports acted_at_other_version when the PR has moved on', async () => {
    mockFind.mockResolvedValueOnce([{
      actionType: 'create_review', connector: 'github-7d07a896',
      targetVersion: 'older11', agentId: 'agent-1', createdAt: new Date('2026-08-20T00:00:00Z'),
    }]);

    const result = await executeStandardTool('have_i_acted_on', {
      connector: 'github', target: GITHUB_PR, version: 'a450b99',
    }, CTX);

    expect((result?.result as { verdict: string }).verdict).toBe('acted_at_other_version');
  });

  it('restates its coverage limits on the answer, not only in the description', async () => {
    // The description is read once at catalog time; the caveat that matters is
    // the one attached to the answer being acted on. "not_acted" means nothing
    // was DISPATCHED — a sandbox `gh pr review` leaves no trace here.
    mockFind.mockResolvedValueOnce([]);
    const result = await executeStandardTool('have_i_acted_on', {
      connector: 'github', target: GITHUB_PR,
    }, CTX);

    const coverage = (result?.result as { coverage: string }).coverage;
    expect(coverage).toMatch(/90 days/);
    expect(coverage).toMatch(/sandbox/i);
  });
});

describe('have_i_acted_on refuses rather than guessing', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails when the target derives to nothing instead of answering "no"', async () => {
    // '' matches every other unkeyed row in the table. Answering from it would
    // be worse than refusing — it is the confident-wrong-answer failure the
    // whole design exists to avoid.
    const result = await executeStandardTool('have_i_acted_on', {
      connector: 'github', target: { query: 'is:open' },
    }, CTX);

    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/could not identify/i);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('fails on a missing connector or a non-object target', async () => {
    expect((await executeStandardTool('have_i_acted_on', { target: GITHUB_PR }, CTX))?.success).toBe(false);
    expect((await executeStandardTool('have_i_acted_on', { connector: 'github' }, CTX))?.success).toBe(false);
    expect((await executeStandardTool('have_i_acted_on', {
      connector: 'github', target: 'PR 17',
    }, CTX))?.success).toBe(false);
    expect(mockFind).not.toHaveBeenCalled();
  });
});
