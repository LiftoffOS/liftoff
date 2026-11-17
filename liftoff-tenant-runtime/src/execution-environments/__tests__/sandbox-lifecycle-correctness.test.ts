// Three things about a sandbox's life that were wrong together.
//
// 1. A run that pauses for a human stops making tool calls, so its heartbeat
//    lapses and the sweep destroys its workspace after 20 minutes. When the
//    human answers, the run resumes and is handed a NEW empty directory with
//    no indication that the old one existed. The agent reads its own missing
//    output as work it never did.
//
// 2. That 20-minute window is a pinned 4 vCPU / 8 GB instance, and it exists
//    only because the heartbeat cannot distinguish "paused" from "finished".
//    For a cron or event run the question has a real answer — the invocation
//    ended — and such a run gets a fresh thread next time, so nothing will ever
//    reattach to that workspace.
//
// 3. The caller in front of the executor gives up at 60s; provisioning may take
//    longer. Holding the request past that returns a gateway timeout while the
//    provision completes anyway.

import { SandboxStateRepository } from '../sandbox-state-repository';

const query = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('a workspace that was reclaimed is reported, not silently replaced', () => {
  it('asks whether this session ever had a sandbox that is now gone', async () => {
    query.mockResolvedValue({ rows: [{ exists: true }] });
    const repo = new SandboxStateRepository();

    await expect(repo.hadDestroyedSandbox('sess-1')).resolves.toBe(true);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/destroyed/);
    expect(sql).toMatch(/error/);
    expect(params).toEqual(['sess-1']);
  });

  it('a session with no history is not a reset', async () => {
    query.mockResolvedValue({ rows: [{ exists: false }] });
    const repo = new SandboxStateRepository();
    await expect(repo.hadDestroyedSandbox('sess-new')).resolves.toBe(false);
  });
});

describe('releasing a finished autonomous run', () => {
  async function runQuery() {
    const repo = new SandboxStateRepository();
    await repo.findFinishedAutonomous();
    return query.mock.calls[0][0] as string;
  }

  it('only releases cron and event runs', async () => {
    const sql = await runQuery();
    expect(sql).toMatch(/triggered_by IN \('cron', 'event'\)/);
  });

  it('never releases a human or agent run', async () => {
    // A person who asked for a run may keep talking in that thread, and a
    // delegated child's parent may still be waiting on it.
    const sql = await runQuery();
    expect(sql).not.toMatch(/'human'/);
    expect(sql).not.toMatch(/'agent'/);
  });

  it('never releases a paused run', async () => {
    // outcome 'gated' means oversight blocked OR PAUSED the run (migration 329).
    const sql = await runQuery();
    expect(sql).toMatch(/outcome <> 'gated'/);
  });

  it('never releases a run still in flight', async () => {
    const sql = await runQuery();
    expect(sql).toMatch(/outcome IS NOT NULL/);
  });

  it('only joins uuid-shaped invocation handles', async () => {
    // invocation_id is text with no FK (migration 286) and carries composite
    // handles for provisioning / sidecar / parity callers.
    const sql = await runQuery();
    expect(sql).toMatch(/\[0-9a-f\]\{8\}/);
  });

  it('leaves already-dead rows alone', async () => {
    const sql = await runQuery();
    expect(sql).toMatch(/status NOT IN \('destroyed', 'error'\)/);
  });
});
