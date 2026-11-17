// settleSkillLearning — the single gate for skill statistics.
//
// Escalated/gated runs are governance decisions, not evidence about skills:
// they must write NOTHING (no usefulness delta, no outcome counters). The
// posted outcome derives from the terminal signal, not toolCallsExecuted —
// the old heuristic posted 'success' for a run that executed tools and then
// failed.

const poolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: poolQuery }),
}));

const postSkillFeedbackMock = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null),
  postSkillFeedback: (...args: unknown[]) => postSkillFeedbackMock(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { settleSkillLearning } from '../skill-learning';

const BASE = {
  tenantId: 't1',
  agentId: 'rt-agent-1',
  taskId: 'task-1',
  injectedSkillIds: ['s1', 's2'],
};

describe('settleSkillLearning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    poolQuery.mockResolvedValue({ rowCount: 2 });
    postSkillFeedbackMock.mockResolvedValue(undefined);
  });

  it('writes nothing for an escalated run (governance is not skill evidence)', async () => {
    const signal = await settleSkillLearning({ ...BASE, terminalState: 'escalated', toolCallsExecuted: 3 });
    expect(signal).toBe('none');
    expect(poolQuery).not.toHaveBeenCalled();
    expect(postSkillFeedbackMock).not.toHaveBeenCalled();
  });

  it('writes nothing for a gated run', async () => {
    const signal = await settleSkillLearning({ ...BASE, terminalState: 'gated', toolCallsExecuted: 1 });
    expect(signal).toBe('none');
    expect(poolQuery).not.toHaveBeenCalled();
    expect(postSkillFeedbackMock).not.toHaveBeenCalled();
  });

  it('posts outcome success and +1 usefulness for a successful run with tools', async () => {
    const signal = await settleSkillLearning({ ...BASE, terminalState: 'success', toolCallsExecuted: 2 });
    expect(signal).toBe('positive');
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('usefulness_score'), [1, ['s1', 's2']]);
    const payload = postSkillFeedbackMock.mock.calls[0][0] as { feedback: Array<{ outcome: string }> };
    expect(payload.feedback.every((f) => f.outcome === 'success')).toBe(true);
  });

  it('posts outcome failure for a FAILED run even when tools executed (the old heuristic posted success)', async () => {
    const signal = await settleSkillLearning({ ...BASE, terminalState: 'task_failed', toolCallsExecuted: 4 });
    expect(signal).toBe('negative');
    const payload = postSkillFeedbackMock.mock.calls[0][0] as { feedback: Array<{ outcome: string }> };
    expect(payload.feedback.every((f) => f.outcome === 'failure')).toBe(true);
    // Usefulness keeps the tool-count axis inside evidentiary runs: tools ran → +1.
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('usefulness_score'), [1, ['s1', 's2']]);
  });

  it('posts outcome success with -1 usefulness for a toolless successful run (skill was noise)', async () => {
    await settleSkillLearning({ ...BASE, terminalState: 'success', toolCallsExecuted: 0 });
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('usefulness_score'), [-1, ['s1', 's2']]);
    const payload = postSkillFeedbackMock.mock.calls[0][0] as { feedback: Array<{ outcome: string }> };
    expect(payload.feedback.every((f) => f.outcome === 'success')).toBe(true);
  });

  it('returns none and writes nothing when no skills were injected', async () => {
    const signal = await settleSkillLearning({ ...BASE, injectedSkillIds: [], terminalState: 'success', toolCallsExecuted: 1 });
    expect(signal).toBe('none');
    expect(poolQuery).not.toHaveBeenCalled();
    expect(postSkillFeedbackMock).not.toHaveBeenCalled();
  });

  it('still posts feedback when the usefulness UPDATE fails (best-effort ordering)', async () => {
    poolQuery.mockRejectedValueOnce(new Error('db down'));
    const signal = await settleSkillLearning({ ...BASE, terminalState: 'success', toolCallsExecuted: 1 });
    expect(signal).toBe('positive');
    expect(postSkillFeedbackMock).toHaveBeenCalledTimes(1);
  });
});
