// Boundary tests for the delay step handler.
//
// We mock the repo + cloud-tasks deps so this stays a pure boundary test
// of the duration/untilIso validation paths.

jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    insert: jest.fn().mockResolvedValue({ id: 'row-1' }),
    updateCloudTaskName: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: jest.fn().mockResolvedValue({
    taskName: 'projects/.../tasks/sched-x',
    scheduleKey: '',
    contextRef: null,
  }),
}));

import { handleDelayStep } from '../handlers/delay-step-handler';

const baseInput = {
  tenantId: 't1',
  agentId: 'a1',
  workflowId: 'wf1',
  taskId: 'task1',
  stepId: 'wait-48h',
  invocationId: 'inv-1',
  resumeAfterStepId: 'send-followup',
};

describe('handleDelayStep', () => {
  it('accepts 60s minimum', async () => {
    const result = await handleDelayStep({
      ...baseInput,
      config: { durationSeconds: 60 },
    });
    expect(result.paused).toBe(true);
    expect(result.resumeAt).toBeInstanceOf(Date);
  });

  it('accepts 30d maximum', async () => {
    const result = await handleDelayStep({
      ...baseInput,
      config: { durationSeconds: 30 * 24 * 60 * 60 },
    });
    expect(result.paused).toBe(true);
  });

  it('rejects durations under 60s', async () => {
    await expect(
      handleDelayStep({ ...baseInput, config: { durationSeconds: 59 } }),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects durations over 30d', async () => {
    await expect(
      handleDelayStep({ ...baseInput, config: { durationSeconds: 30 * 24 * 60 * 60 + 1 } }),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects when both durationSeconds and untilIso are absent', async () => {
    await expect(
      handleDelayStep({ ...baseInput, config: {} }),
    ).rejects.toThrow(/requires durationSeconds or untilIso/);
  });

  it('rejects untilIso strings that are not valid ISO timestamps', async () => {
    await expect(
      handleDelayStep({ ...baseInput, config: { untilIso: 'not-a-date' } }),
    ).rejects.toThrow(/not a valid ISO date/);
  });

  it('rejects untilIso resolved to the past', async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await expect(
      handleDelayStep({ ...baseInput, config: { untilIso: past } }),
    ).rejects.toThrow(/out of range/);
  });

  it('accepts a valid future untilIso', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const result = await handleDelayStep({
      ...baseInput,
      config: { untilIso: future },
    });
    expect(result.paused).toBe(true);
  });
});
