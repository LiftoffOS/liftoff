// Bounding a routine that is looping rather than waiting.
//
// The overlap guard stops tick N+1 starting while tick N is alive. It does not
// stop tick N being alive forever, and a routine caught in a retry loop holds
// its own schedule closed while burning tokens.
//
// The distinction an earlier pass got wrong, and which these tests pin: a run
// WAITING on a human must never be killed — it consumes nothing and killing it
// strands the person's decision — while a run ACTIVE past its deadline is
// exactly what should stop. A live loop heartbeats, so heartbeating cannot be
// the thing that protects it.

import { routineActiveDeadline } from '../../invocations/service';

const NOW = new Date('2026-08-05T12:00:00Z');

describe('routineActiveDeadline', () => {
  it('gives a routine run a deadline', () => {
    const d = routineActiveDeadline('companion:morning-sweep', NOW);
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('gives a chat turn none', () => {
    // Somebody is sitting there waiting for it; a deadline would cut them off.
    expect(routineActiveDeadline(undefined, NOW)).toBeNull();
    expect(routineActiveDeadline(null, NOW)).toBeNull();
  });

  it('gives a delegated child none', () => {
    // Bounded by its parent already.
    expect(routineActiveDeadline('delegate_to_agent:abc', NOW)).toBeNull();
  });

  it('gives a self-wake none', () => {
    // A wake is the WAITING case in its purest form.
    expect(routineActiveDeadline('self_wake:abc', NOW)).toBeNull();
  });

  it('is a bound, not a race — comfortably longer than a real routine turn', () => {
    const d = routineActiveDeadline('companion:x', NOW)!;
    const minutes = (d.getTime() - NOW.getTime()) / 60_000;
    expect(minutes).toBeGreaterThanOrEqual(15);
  });
});

describe('the reconciler contract', () => {
  // Read the SQL rather than exercise a live database: what matters is that the
  // predicate says the right thing, and these are the clauses that make the
  // difference between bounding a loop and killing a run awaiting approval.
  const sql = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'stalled-run-reconciler.ts'),
    'utf8',
  ) as string;

  it('sweeps a run past its deadline as well as one past the grace window', () => {
    expect(sql).toMatch(/active_deadline_at IS NOT NULL AND i\.active_deadline_at < NOW\(\)/);
  });

  it('stops letting a heartbeat protect a run that is past its deadline', () => {
    // Without this a looping routine is immune, because looping is exactly what
    // keeps a heartbeat fresh.
    expect(sql).toMatch(/ars\.updated_at >= NOW\(\) - \$\{STALL\}\s*\n\s*AND \(i\.active_deadline_at IS NULL OR i\.active_deadline_at >= NOW\(\)\)/);
  });

  it('still refuses to touch a run with a pending scheduled resume', () => {
    // This is what exempts HITL / clarification / wake — the run is paused, not
    // running, and its resume is already scheduled.
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM agent_scheduled_invocations asi/);
    expect(sql).toMatch(/asi\.status = 'pending'/);
  });

  it('records the two cases distinctly, so a loop is not filed as a stall', () => {
    expect(sql).toMatch(/THEN 'routine_hard_bound'/);
    expect(sql).toMatch(/ELSE 'stalled'/);
  });
});
