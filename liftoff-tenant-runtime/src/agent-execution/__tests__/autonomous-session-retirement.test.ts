// Abandoning a saturated autonomous session, and keeping it abandoned.
//
// The autonomous path checkpoints after every tool call, fire-and-forget. So by
// the time a run ends there is already a persisted transcript, and the retire is
// an UNDO rather than a skip. That makes the ordering load-bearing in a way the
// chat path's single guarded write never is: a checkpoint still in flight when
// the run ended can land after the retire, and if it clears the flag the very
// next delivery restores the conversation we just gave up on and dies the same
// way — forever, since each attempt re-persists it.

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { retireRunSession, loadRunSession, saveRunSession } from '../autonomous-session';

const TRIGGER = 'trigger-key-1';
const AGENT = '11111111-1111-1111-1111-111111111111';
const SID = 'sdk-session-abc';

beforeEach(() => {
  jest.clearAllMocks();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('retireRunSession', () => {
  it('flags the row rather than deleting the evidence', () => {
    return retireRunSession(TRIGGER, AGENT, SID, 'context_exhausted_completion').then(() => {
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/UPDATE agent_run_sessions/);
      expect(sql).toMatch(/SET retired_session_id = sdk_session_id/);
      expect(sql).not.toMatch(/DELETE/);
      expect(params).toEqual([TRIGGER, AGENT, SID]);
    });
  });

  it('retires only the session it was told to', () => {
    // Not the row: a later run's fresh session sharing the same (trigger, agent)
    // key must not inherit an abandonment that was about a different transcript.
    return retireRunSession(TRIGGER, AGENT, SID, 'x').then(() => {
      const [sql] = query.mock.calls[0];
      expect(sql).toMatch(/AND sdk_session_id = \$3/);
    });
  });

  it('never throws — the run it describes has already finished', async () => {
    query.mockRejectedValue(new Error('pool exhausted'));
    await expect(retireRunSession(TRIGGER, AGENT, SID, 'x')).resolves.toBeUndefined();
  });
});

describe('loadRunSession', () => {
  it('skips a retired session', async () => {
    await loadRunSession(TRIGGER, AGENT, 'claude-agent-sdk');
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/retired_session_id IS DISTINCT FROM sdk_session_id/);
  });
});

describe('saveRunSession — the race with a retirement', () => {
  it('clears a retirement only for a DIFFERENT session', async () => {
    await saveRunSession(TRIGGER, AGENT, SID, '{"type":"user"}');
    const [sql] = query.mock.calls[0];
    // A new conversation clears the flag; a checkpoint landing late for the
    // SAME conversation must not resurrect what was just abandoned.
    expect(sql).toMatch(/retired_session_id\s+=\s*\n?\s*CASE WHEN agent_run_sessions\.retired_session_id IS DISTINCT FROM EXCLUDED\.sdk_session_id/);
    expect(sql).toMatch(/THEN NULL/);
    expect(sql).toMatch(/ELSE agent_run_sessions\.retired_session_id/);
  });

  it('does not clear it unconditionally', async () => {
    await saveRunSession(TRIGGER, AGENT, SID, '{"type":"user"}');
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/retired_session_id\s+=\s*NULL\b/);
  });
});
