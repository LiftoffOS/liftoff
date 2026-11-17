// Change D D.2.5: assert branch-tracker passes agent_action with branch+invocation refId.

jest.mock('../../infrastructure/database', () => ({ pool: { query: jest.fn() } }));

const saveMemory = jest.fn().mockResolvedValue({ memoryId: 'mem-1', deduplicated: false });
jest.mock('../../memory/service', () => ({ memoryService: { saveMemory } }));

import { writeBranchCompletionMemory } from '../branch-tracker';

describe('branch-tracker source', () => {
  beforeEach(() => { saveMemory.mockClear(); });

  it('uses agent_action with branch+invocation refId', async () => {
    await writeBranchCompletionMemory('t1', 'a1', 'feature/xyz', 'Done', 'inv-abc');
    expect(saveMemory).toHaveBeenCalledTimes(1);
    const opts = saveMemory.mock.calls[0][0];
    expect(opts.source).toMatchObject({
      nodeType: 'agent_action',
      agentId: 'a1',
    });
    expect(opts.source.refId).toMatch(/^branch-completion-feature\/xyz-inv-abc$/);
  });

  it('falls back to timestamp when invocationId is omitted', async () => {
    await writeBranchCompletionMemory('t1', 'a1', 'main', null);
    const opts = saveMemory.mock.calls[0][0];
    expect(opts.source.refId).toMatch(/^branch-completion-main-\d+$/);
  });
});
