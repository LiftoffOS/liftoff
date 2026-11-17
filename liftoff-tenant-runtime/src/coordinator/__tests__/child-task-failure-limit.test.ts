// Stopping a delegated task that fails every attempt.
//
// The stall reconciler catches a run that STOPPED. This is the opposite: a task
// the dispatcher keeps retrying, failing the same way each time, burning a
// whole child agent run per attempt.
//
// The part that is easy to get wrong is not the counter — it is that `blocked`
// must count as TERMINAL for fan-in. A parent waiting on children only
// recognises statuses it knows about, so a blocked task that is not recognised
// turns a bounded failure into a workflow that waits out its full timeout.

import { ChildTaskRepository } from '../repository';

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => query(...a) },
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ct-1', parent_task_id: 'pt-1', workflow_id: 'wf-1', task_type: 'subtask',
    objective: 'o', status: 'failed', result: null, error: 'boom',
    consecutive_failures: 1, blocked_at: null,
    created_at: new Date(), updated_at: new Date(), completed_at: null, agent_id: null,
    ...over,
  };
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [row()], rowCount: 1 });
});

describe('the limit', () => {
  it('is small, because each attempt is a whole child run', () => {
    expect(ChildTaskRepository.MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(0);
    expect(ChildTaskRepository.MAX_CONSECUTIVE_FAILURES).toBeLessThanOrEqual(3);
  });
});

describe('fail()', () => {
  const repo = new ChildTaskRepository();

  it('counts and decides in ONE statement', async () => {
    await repo.fail('ct-1', 'boom');
    const [sql] = query.mock.calls[0];
    // Read-then-write would let two concurrent failures both see the old count
    // and both decide they are not yet at the limit.
    expect(sql).toMatch(/consecutive_failures = consecutive_failures \+ 1/);
    expect(sql).toMatch(/WHEN consecutive_failures \+ 1 >= \$3 THEN 'abandoned'/);
  });

  it('stamps blocked_at only when it actually abandons', async () => {
    const [sql] = (await repo.fail('ct-1', 'boom'), query.mock.calls[0]);
    expect(sql).toMatch(/blocked_at = CASE\s*\n?\s*WHEN consecutive_failures \+ 1 >= \$3 THEN NOW\(\) ELSE blocked_at END/);
  });

  it('passes the configured limit rather than hardcoding it in SQL', async () => {
    await repo.fail('ct-1', 'boom');
    expect(query.mock.calls[0][1]).toContain(ChildTaskRepository.MAX_CONSECUTIVE_FAILURES);
  });

  it('surfaces the failure count and abandoned state on the returned task', async () => {
    query.mockResolvedValue({
      rows: [row({ status: 'blocked', consecutive_failures: 2, blocked_at: new Date() })],
      rowCount: 1,
    });
    const t = await repo.fail('ct-1', 'boom');
    expect(t.status).toBe('blocked');
    expect(t.consecutiveFailures).toBe(2);
    expect(t.blockedAt).not.toBeNull();
  });
});

describe('complete()', () => {
  const repo = new ChildTaskRepository();

  it('clears the streak', async () => {
    // Otherwise a task that fails, succeeds, then fails is one attempt from
    // being blocked despite having worked in between.
    query.mockResolvedValue({ rows: [row({ status: 'completed', consecutive_failures: 0 })], rowCount: 1 });
    await repo.complete('ct-1', { ok: true });
    expect(query.mock.calls[0][0]).toMatch(/consecutive_failures = 0/);
  });
});

describe('fan-in treats abandoned as terminal', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'),
    'utf8',
  ) as string;

  it('has one shared terminal predicate rather than three inline checks', () => {
    expect(src).toMatch(/function isTerminalChildStatus/);
    expect(src).toMatch(/TERMINAL_CHILD_STATUSES = \['completed', 'failed', 'abandoned'\]/);
  });

  it('uses it at every fan-in site', () => {
    // Three sites: the wait loop, the graph collector, and the timeout
    // collector. Missing any one leaves a parent waiting on a task that has
    // already given up.
    const uses = src.match(/isTerminalChildStatus\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4); // 1 definition + 3 call sites
  });

  it('leaves no inline child-task completed-or-failed check behind', () => {
    // Scoped to child tasks (`t.status`). ToolCall has its own
    // completed/failed check in this file and no blocked state, so a blanket
    // match would flag unrelated correct code.
    expect(src).not.toMatch(/t\.status === 'completed' \|\| t\.status === 'failed'/);
  });
});

describe('the status the limit parks a task in', () => {
  // The whole defect this fixes was a word. `blocked` already meant "waiting on
  // dependencies" — it is set on every child that declares a `dependsOn` — and
  // borrowing it for the failure limit broke things in both directions at once.
  const repoSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'repository.ts'), 'utf8',
  ) as string;
  const svcSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('abandons rather than blocking', () => {
    expect(repoSrc).toMatch(/THEN 'abandoned' ELSE 'failed' END/);
    expect(repoSrc).not.toMatch(/THEN 'blocked' ELSE 'failed' END/);
  });

  it('does NOT let the async advance path resurrect it', () => {
    // The leak: that query un-blocks any `blocked` child whose dependencies
    // have all completed. A task that ran and failed twice necessarily HAS
    // completed dependencies, so the next sibling completion put it back on the
    // dispatcher and burned another child run — then it re-blocked, then the
    // next graph event un-blocked it again. The limit held in sync graphs and
    // leaked in exactly the async graphs it was written for.
    //
    // Asserted as: the advance query still targets ONLY `blocked`, and the
    // limit no longer writes that status, so the two cannot meet.
    const advance = svcSrc.slice(svcSrc.indexOf("UPDATE child_tasks c SET status='pending'"));
    expect(advance.slice(0, 400)).toMatch(/c\.status='blocked'/);
    expect(advance.slice(0, 400)).not.toMatch(/abandoned/);
  });

  it('keeps a dependency-blocked task NON-terminal at fan-in', () => {
    // The defect the fix itself introduced, and the worse of the two: widening
    // the predicate to cover `blocked` meant a fan-in counted a child that had
    // not run at all as finished, and resumed the parent early.
    const set = svcSrc.match(/TERMINAL_CHILD_STATUSES = \[([^\]]*)\]/)?.[1] ?? '';
    expect(set).not.toMatch(/blocked/);
    expect(svcSrc).not.toMatch(/status === 'blocked'/);
  });

  it('derives the SQL status list from the predicate instead of retyping it', () => {
    // This used to be kept in step by hand, and the hand missed a site:
    // expireGraphIfStuck still said NOT IN ('completed','failed'), so a graph
    // timeout overwrote abandoned rows to failed/graph_timeout and erased both
    // the real error and the record that the task had given up on its own.
    expect(svcSrc).toMatch(/TERMINAL_CHILD_STATUS_SQL = TERMINAL_CHILD_STATUSES\.map/);
    // No child_tasks status set spelled out inline any more.
    expect(svcSrc).not.toMatch(/status NOT IN \('completed','failed'\)/);
    expect(svcSrc).not.toMatch(/status NOT IN \('completed','failed','abandoned'\)/);
    // Both status-set queries go through the derived list.
    const uses = svcSrc.match(/NOT IN \(\$\{TERMINAL_CHILD_STATUS_SQL\}\)/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it('does not let a graph timeout restamp an abandoned task', async () => {
    // The one that got missed. Invoked for real rather than read, because the
    // damage is in the statement the method actually issues.
    const { CoordinatorService } = await import('../service');
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    query.mockClear();

    await new CoordinatorService().expireGraphIfStuck('pt-1');

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/error='graph_timeout'/);
    // An abandoned row is already terminal and already carries a real error.
    expect(sql).toMatch(/'abandoned'/);
  });

  it('migrates the rows the old code already wrote', () => {
    // `blocked_at` is the exact discriminator: nothing else sets it, because a
    // dependency-block goes through updateStatus() which touches only status.
    const migration = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', '..', 'migrations', '342_child_task_abandoned_status.sql'),
      'utf8',
    ) as string;
    expect(migration).toMatch(/SET status = 'abandoned'/);
    expect(migration).toMatch(/WHERE status = 'blocked'\s*\n\s*AND blocked_at IS NOT NULL/);
  });
});
