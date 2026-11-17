// A deduped clarification must not arm a second expiry Cloud Task.
//
// insertClarificationRow already refuses to open a second question for an agent
// that has one outstanding — a scheduled agent whose blocker recurs would
// otherwise open one per tick. That dedup works: the row count stays at 1.
//
// The expiry Cloud Task is armed by the CALLER, after the transaction. If it
// runs whether or not the row was deduped, and both outcomes return the same
// `{scheduledRowId, threadId}`, createClarificationPause cannot tell them
// apart. Two things then compound it:
//
//   - `contextRef` is `clarification:<agentId>:<invocationId>:<step>` and
//     invocationId is fresh per run, so the derived Cloud Task NAME is unique
//     every tick. Cloud Tasks rejects a duplicate task name, which would cap
//     this at one — the uniqueness removes the only backstop.
//   - updateCloudTaskName then overwrites the row's pointer with the newest
//     task, orphaning the previous one. Nothing can cancel it; it just fires.
//
// The result: ONE pending clarification row and a growing queue of Cloud
// Tasks, all for the escalation step. Each fires, escalates to Slack, and
// pauses again — arming another, so the agent posts an escalation every tick.
// Every database-level check reports a single healthy row, which is why
// nothing catches it.
//
// The dedup's own comment promises "deliberately no new thread, message or
// expiry task". Without this guard only two of those three hold.
import { readFileSync } from 'fs';
import { join } from 'path';

const storageSrc = readFileSync(
  join(__dirname, '..', 'clarification-storage.ts'), 'utf8',
);
const serviceSrc = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** createClarificationPause, from its signature to the lifecycle update that
 *  follows the enqueue block. */
function pauseFn(): string {
  const start = serviceSrc.indexOf('public async createClarificationPause(');
  expect(start).toBeGreaterThan(-1);
  // The status write that follows the enqueue block. It moved behind
  // setRuntimeStatus when that write was made non-fatal (a rejected transition
  // from a concurrent run of the same agent used to throw here, before the
  // return that carries the question, so the user was never asked). Matched on
  // the argument list, which is what actually marks the spot.
  const end = serviceSrc.indexOf("RuntimeStatus(ctx.agentId, 'WAITING_FOR_HUMAN')", start);
  expect(end).toBeGreaterThan(start);
  return serviceSrc.slice(start, end);
}

describe('insertClarificationRow', () => {
  it('tells the caller whether it deduped', () => {
    // The whole defect is that it did not. Same shape for both outcomes meant
    // the caller had no way to skip the arming.
    expect(storageSrc).toMatch(/deduped:\s*boolean/);
  });

  it('reports deduped=true on the early return and false on a real insert', () => {
    const early = storageSrc.indexOf('return { scheduledRowId: id, threadId: existingThreadId');
    expect(early).toBeGreaterThan(-1);
    expect(storageSrc.slice(early, early + 160)).toContain('deduped: true');

    const fresh = storageSrc.lastIndexOf('return { scheduledRowId, threadId');
    expect(fresh).toBeGreaterThan(-1);
    expect(storageSrc.slice(fresh, fresh + 120)).toContain('deduped: false');
  });
});

describe('createClarificationPause', () => {
  it('reads the deduped flag out of the insert', () => {
    expect(pauseFn()).toMatch(/\{\s*scheduledRowId,\s*threadId,\s*deduped\s*\}/);
  });

  it('gates the expiry-task enqueue on it', () => {
    const fn = pauseFn();
    const guard = fn.indexOf('if (deduped)');
    const enqueue = fn.indexOf('enqueueAgentExecution');
    expect(guard).toBeGreaterThan(-1);
    // The guard must come BEFORE the enqueue — a check after the task is armed
    // is not a check.
    expect(guard).toBeLessThan(enqueue);
  });

  it('does not overwrite the row cloud_task_name when deduped', () => {
    // updateCloudTaskName orphaned the previous task, which is what made the
    // leaked tasks uncancellable. It must sit inside the not-deduped path.
    //
    // Anchored on the CALL, not the bare name: the comment above the guard
    // explains the bug and names the function, and matching that instead was
    // enough to make an earlier version of this test pass on prose.
    const fn = pauseFn();
    const guard = fn.indexOf('if (deduped)');
    const call = fn.indexOf('agentScheduledInvocationsRepo.updateCloudTaskName(');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
  });

  it('does not route the deduped case through the failure catch', () => {
    // That catch records a `recovery_arming` pause failure. A dedup is the
    // system working; reporting it as a degraded pause every tick would bury
    // the real ones.
    const fn = pauseFn();
    const guard = fn.indexOf('if (deduped)');
    const between = fn.slice(guard, fn.indexOf('enqueueAgentExecution'));
    expect(between).not.toContain('throw');
  });
});
