// One live Cloud Task per scheduled row, enforced by Cloud Tasks itself.
//
// The default task name is `sched-{agentId}-{scheduleKey}-{contextRef}`, and
// clarification's contextRef embeds the per-run `invocationId` — fresh every
// tick. So every arming minted a UNIQUE name, and the one backstop that could
// have contained a runaway (Cloud Tasks refusing a duplicate name) never
// engaged: ONE pending clarification row can sit behind many queued tasks,
// each firing the escalation step and arming another, while every
// database-level diagnostic reports a single healthy row.
//
// The caller-side dedup is a code-path guarantee — it holds only for paths that remember to check. This is the
// structural half, and it holds for armings written later by someone who never
// read that guard.
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'cloud-tasks.ts'), 'utf8');
const svc = readFileSync(
  join(__dirname, '..', '..', 'agent-execution', 'service.ts'), 'utf8',
);

describe('taskIdentity', () => {
  it('replaces the invocation-derived name when supplied', () => {
    expect(src).toContain('opts.taskIdentity');
    expect(src).toMatch(/tasks\/row-\$\{opts\.taskIdentity/);
  });

  it('still uses the legacy name when not supplied', () => {
    // Every other caller keeps the cancellable scheduleKey+contextRef shape,
    // which cancelScheduledAgentExecution reconstructs to find a task.
    expect(src).toContain('buildAgentTaskName(queuePath, agentId, opts.scheduleKey, contextRef)');
  });

  it('sanitises the identity into a legal task-name segment', () => {
    // A row id is a UUID today, but the identity is a string and Cloud Tasks
    // rejects a name with characters outside [A-Za-z0-9_-].
    expect(src).toMatch(/taskIdentity\.replace\(/);
  });
});

describe('ALREADY_EXISTS', () => {
  it('is treated as success when an identity was supplied', () => {
    // Making names collide while letting the collision throw would turn a
    // benign duplicate into an error on a path whose whole job is idempotence.
    const guard = src.slice(src.indexOf('let response'));
    expect(guard.slice(0, 900)).toContain('code === 6');
    expect(guard.slice(0, 900)).toContain('opts.taskIdentity');
  });

  it('still throws when no identity was supplied', () => {
    // Without an identity a collision is a genuine surprise, not the design.
    const guard = src.slice(src.indexOf('let response'), src.indexOf('let response') + 1200);
    expect(guard).toMatch(/if \(opts\.taskIdentity && code === 6\)/);
    expect(guard).toContain('throw err');
  });

  it('returns the intended name, not an empty one, on collision', () => {
    // The caller writes this into cloud_task_name; returning undefined would
    // orphan the task that actually exists.
    const guard = src.slice(src.indexOf('code === 6'), src.indexOf('code === 6') + 700);
    expect(guard).toContain('return { taskName');
  });
});

describe('the clarification arming site', () => {
  it('passes a row-scoped identity', () => {
    expect(svc).toMatch(/taskIdentity: `\$\{scheduledRowId\}-a0`/);
  });

  it('carries an attempt suffix, not a bare row id', () => {
    // Cloud Tasks retains a completed task's name for ~1h. A bare row id would
    // refuse the legitimate re-arm after a failed resume inside that window;
    // the attempt number keeps duplicates colliding and retries distinct.
    expect(svc).not.toMatch(/taskIdentity: `\$\{scheduledRowId\}`/);
    expect(svc).toMatch(/scheduledRowId\}-a\d/);
  });
});
