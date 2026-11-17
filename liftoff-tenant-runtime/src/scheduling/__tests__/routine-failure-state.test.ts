// J3 — the consecutive-failure pause.
//
// Three failures in a row stop the agent. WHERE that stop is recorded is the
// part that matters: it goes through the control plane's agent status, the same
// one the dashboard's Pause button sets and the Resume button clears.
//
// The earlier version paused the routine's Cloud Scheduler job and set a
// `failure_paused` flag the reconciler honoured. That produced a stop the
// operator could not see (the status column still read Active), could not undo
// (Resume never touched the flag), and in fact nothing in the codebase ever
// cleared — a one-way switch on someone's team. An operator must always be able
// to restart their own agent, whatever it costs them to run it.

import {
  ROUTINE_FAILURE_PAUSE_THRESHOLD,
  countsTowardRoutinePause,
  recordRoutineOutcome,
} from '../routine-failure-state';
import type { FailureClass } from '../../invocations/types';

const query = jest.fn();
const pauseJob = jest.fn();
const pauseCanonicalAgent = jest.fn();
const resolveInternalAgentId = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../cloud-scheduler', () => ({
  pauseJob: (...a: unknown[]) => pauseJob(...a),
}));
jest.mock('../../clients/platform-backend-client', () => ({
  pauseCanonicalAgent: (...a: unknown[]) => pauseCanonicalAgent(...a),
}));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => resolveInternalAgentId(...a),
}));

/** Make the failure INSERT report a given streak length. */
function streakIs(n: number) {
  query.mockImplementation(async (sql: string) => {
    if (/INSERT INTO routine_failure_state/.test(sql)) {
      return { rows: [{ consecutive_failures: n }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  pauseJob.mockResolvedValue(undefined);
  pauseCanonicalAgent.mockResolvedValue(true);
  resolveInternalAgentId.mockResolvedValue('99999999-9999-9999-9999-999999999999');
});

const routine = {
  tenantId: 'tenant-1',
  agentId: '11111111-1111-1111-1111-111111111111',
  triggeredByLabel: 'companion:morning-sweep',
};

describe('the threshold', () => {
  it('is a real, positive number', () => {
    expect(ROUTINE_FAILURE_PAUSE_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isFinite(ROUTINE_FAILURE_PAUSE_THRESHOLD)).toBe(true);
  });
});

describe('recordRoutineOutcome', () => {
  it('does not pause on the first failure', async () => {
    streakIs(1);
    await recordRoutineOutcome({ ...routine, success: false, error: 'boom' });
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });

  it('does not pause one short of the threshold', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD - 1);
    await recordRoutineOutcome({ ...routine, success: false, error: 'boom' });
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });

  it('pauses the AGENT at the threshold, via the control plane', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    await recordRoutineOutcome({ ...routine, success: false, error: 'boom' });

    expect(pauseCanonicalAgent).toHaveBeenCalledWith(
      routine.tenantId,
      '99999999-9999-9999-9999-999999999999',
    );
  });

  it('NEVER pauses a Cloud Scheduler job', async () => {
    // The scheduler is downstream of agent status, never the place a stop is
    // applied. A job paused here is invisible to the status column.
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    await recordRoutineOutcome({ ...routine, success: false, error: 'boom' });
    expect(pauseJob).not.toHaveBeenCalled();
  });

  it('records no pause state of its own', async () => {
    // Anything written here is state the Resume button does not know about.
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    await recordRoutineOutcome({ ...routine, success: false, error: 'boom' });

    const wrotePauseState = query.mock.calls.some(([sql]) =>
      /failure_paused|paused_at/.test(sql as string));
    expect(wrotePauseState).toBe(false);
  });

  it('translates the runtime id before handing it to the control plane', async () => {
    // internal_agents.id and the runtime's agents.id are disjoint; a runtime id
    // matches zero rows upstream and fails silently (INV-TR-010).
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    await recordRoutineOutcome({ ...routine, success: false, error: 'boom' });

    expect(resolveInternalAgentId).toHaveBeenCalledWith(
      routine.tenantId,
      routine.agentId,
      expect.any(String),
    );
  });

  it('does not pause when the id cannot be translated', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    resolveInternalAgentId.mockResolvedValue(null);
    await recordRoutineOutcome({ ...routine, success: false, error: 'boom' });
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });

  it('resets the streak on success', async () => {
    await recordRoutineOutcome({ ...routine, success: true });

    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/consecutive_failures = 0/);
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });

  it('leaves the primary schedule alone — only companion routines count', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    await recordRoutineOutcome({ ...routine, triggeredByLabel: undefined, success: false });
    await recordRoutineOutcome({ ...routine, triggeredByLabel: 'self_wake:abc', success: false });

    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('never throws when the pause itself fails', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    pauseCanonicalAgent.mockRejectedValue(new Error('control plane unavailable'));
    await expect(recordRoutineOutcome({ ...routine, success: false })).resolves.toBeUndefined();
  });

  it('never throws when the counter write fails', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(recordRoutineOutcome({ ...routine, success: false })).resolves.toBeUndefined();
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });
});

// ── The breaker only counts evidence about the ROUTINE ───────────────────────
//
// The counter exists to catch a routine that is configured wrong, because no
// amount of retrying fixes that. A provider at capacity, a lapsed entitlement
// and an agent that is simply busy are none of them that, and counting them
// stopped healthy customers' automations for reasons that cleared themselves.

describe('countsTowardRoutinePause', () => {
  const doesNotCount: FailureClass[] = [
    'provider_capacity',
    'provider_server_error',
    'provider_network',
    'provider_auth',
    'provider_quota',
    'context_overflow',
    'admission_denied',
    'agent_busy',
    'lifecycle_not_active',
  ];

  const counts: FailureClass[] = [
    'tool_error',
    'validation',
    'agent_declined',
    'timeout',
    'stalled',
    'unknown',
    'task_failed',
    'recovery_declined',
    'limit_reached',
    'transient_infra',
  ];

  it.each(doesNotCount)('%s is not evidence about the routine', (fc) => {
    expect(countsTowardRoutinePause(fc)).toBe(false);
  });

  it.each(counts)('%s is', (fc) => {
    expect(countsTowardRoutinePause(fc)).toBe(true);
  });

  // The two routine-script call sites classify nothing, and a deterministic
  // script fault is exactly what the threshold is for.
  it('counts an absent class, preserving the unclassified callers', () => {
    expect(countsTowardRoutinePause(undefined)).toBe(true);
    expect(countsTowardRoutinePause(null)).toBe(true);
  });
});

describe('recordRoutineOutcome — class-aware', () => {
  it('does not pause after repeated provider capacity failures', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    for (let i = 0; i < ROUTINE_FAILURE_PAUSE_THRESHOLD; i++) {
      await recordRoutineOutcome({
        ...routine, success: false, error: 'overloaded', failureClass: 'provider_capacity',
      });
    }
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });

  it('does not pause after repeated agent_busy results', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    for (let i = 0; i < ROUTINE_FAILURE_PAUSE_THRESHOLD; i++) {
      await recordRoutineOutcome({
        ...routine, success: false, error: 'agent_already_running', failureClass: 'agent_busy',
      });
    }
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });

  it('does not pause after repeated admission denials', async () => {
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    for (let i = 0; i < ROUTINE_FAILURE_PAUSE_THRESHOLD; i++) {
      await recordRoutineOutcome({
        ...routine, success: false, error: 'Admission denied: Insufficient credits',
        failureClass: 'admission_denied',
      });
    }
    expect(pauseCanonicalAgent).not.toHaveBeenCalled();
  });

  it('still pauses after three genuine, unclassified routine failures', async () => {
    // The streak mock reports the threshold on every call, so the assertion that
    // matters is that each one COUNTS — an uncounted class returns before the
    // counter is touched at all.
    let calls = 0;
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO routine_failure_state/.test(sql)) {
        calls += 1;
        return { rows: [{ consecutive_failures: calls }] };
      }
      return { rows: [] };
    });
    for (let i = 0; i < ROUTINE_FAILURE_PAUSE_THRESHOLD; i++) {
      await recordRoutineOutcome({
        ...routine, success: false, error: 'routine_script_no_sandbox', failureClass: null,
      });
    }
    expect(calls).toBe(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    expect(pauseCanonicalAgent).toHaveBeenCalledTimes(1);
  });

  it('touches nothing at all for an uncounted failure', async () => {
    // Neither adding to the streak nor clearing it: one 429 between two genuine
    // failures must not reset a routine that IS broken back to zero.
    streakIs(ROUTINE_FAILURE_PAUSE_THRESHOLD);
    await recordRoutineOutcome({
      ...routine, success: false, error: 'overloaded', failureClass: 'provider_capacity',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('still records SUCCESS regardless of any class carried alongside it', async () => {
    await recordRoutineOutcome({ ...routine, success: true, failureClass: 'provider_capacity' });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/consecutive_failures = 0/);
  });
});
