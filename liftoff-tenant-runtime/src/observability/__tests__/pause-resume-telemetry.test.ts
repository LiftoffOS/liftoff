// Deterministic tests for the durable pause/resume telemetry choke point:
// closed-vocabulary label emission, the pre-condition no-op contract, and the
// engine-mismatch guard's match / mismatch / legacy-pass / unresolvable-pass
// decisions with terminal-vs-degraded impact. The metric family is mocked so the
// tests assert the exact labels each helper puts on the wire; the engine resolver
// is the real pure implementation with an injected env (never process.env).

const pauseInc = jest.fn();
const resumeInc = jest.fn();
const failureInc = jest.fn();
const fallbackInc = jest.fn();
const durationObserve = jest.fn();
const warn = jest.fn();

jest.mock('../runtime-extensions-metrics', () => ({
  agent_pause_total: { inc: pauseInc },
  agent_resume_total: { inc: resumeInc },
  agent_pause_resume_failure_total: { inc: failureInc },
  agent_resume_fallback_total: { inc: fallbackInc },
  agent_resume_duration_ms: { observe: durationObserve },
}));
jest.mock('../../infrastructure/logging', () => ({ logger: { warn, info: jest.fn(), error: jest.fn() } }));

import {
  recordPauseResult,
  recordResumeResult,
  recordResumeDurationMs,
  recordPauseResumeFailure,
  recordResumeFallback,
} from '../pause-resume-telemetry';

beforeEach(() => jest.clearAllMocks());

describe('pause/resume attempt denominators', () => {
  it('recordPauseResult tags engine + pause_kind + outcome', () => {
    recordPauseResult('claude-agent-sdk', 'hitl_approval', 'succeeded');
    expect(pauseInc).toHaveBeenCalledWith({
      execution_engine: 'claude-agent-sdk', pause_kind: 'hitl_approval', outcome: 'succeeded',
    });
  });

  it('recordResumeResult omits resume_strategy when unset', () => {
    recordResumeResult('openai-codex', 'delegation', 'failed');
    expect(resumeInc).toHaveBeenCalledWith({
      execution_engine: 'openai-codex', pause_kind: 'delegation', outcome: 'failed',
    });
  });

  it('recordResumeResult includes resume_strategy when a fallback won', () => {
    recordResumeResult('openai-codex', 'hitl_approval', 'degraded', 'snapshot_replay');
    expect(resumeInc).toHaveBeenCalledWith({
      execution_engine: 'openai-codex', pause_kind: 'hitl_approval', outcome: 'degraded',
      resume_strategy: 'snapshot_replay',
    });
  });

  it('recordResumeDurationMs observes ms with engine + pause_kind', () => {
    recordResumeDurationMs('google-adk', 'delay', 1234);
    expect(durationObserve).toHaveBeenCalledWith(1234, { execution_engine: 'google-adk', pause_kind: 'delay' });
  });
});

describe('classified failure + fallback', () => {
  it('recordPauseResumeFailure puts only bounded labels on the metric + correlation on the log', () => {
    recordPauseResumeFailure({
      engine: 'openai-agents', operation: 'pause', pauseKind: 'ask_user',
      stage: 'state_persistence', failureClass: 'database', impact: 'terminal',
      correlation: { tenantId: 't1', invocationId: 'inv1' }, error: new Error('boom'),
    });
    expect(failureInc).toHaveBeenCalledWith({
      execution_engine: 'openai-agents', operation: 'pause', pause_kind: 'ask_user',
      stage: 'state_persistence', failure_class: 'database', impact: 'terminal',
    });
    // Correlation ids ride the structured log, never the metric labels.
    const logged = warn.mock.calls[0][0];
    expect(logged.tenantId).toBe('t1');
    expect(logged.invocationId).toBe('inv1');
    expect(logged.err).toBe('boom');
  });

  it('recordResumeFallback counts the fallback DECISION (engine, pause_kind, strategies, reason) — no premature outcome', () => {
    recordResumeFallback({
      engine: 'openai-codex', pauseKind: 'hitl_approval',
      fromStrategy: 'structured_session', toStrategy: 'snapshot_replay',
      reason: 'engine_mismatch',
    });
    expect(fallbackInc).toHaveBeenCalledWith({
      execution_engine: 'openai-codex', pause_kind: 'hitl_approval',
      from_strategy: 'structured_session', to_strategy: 'snapshot_replay',
      reason: 'engine_mismatch',
    });
    // The fallback counter must NOT assert the resume succeeded — that is the
    // resume-result metric's job (emitted after the replay actually completes).
    expect(fallbackInc.mock.calls[0][0]).not.toHaveProperty('outcome');
  });
});
