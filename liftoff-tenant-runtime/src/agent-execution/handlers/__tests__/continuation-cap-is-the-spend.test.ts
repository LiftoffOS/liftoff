/**
 * A run continues while the workspace can pay for it.
 *
 * The chain was bounded by DURATION: six continuations, "about an hour of
 * work", plus a cumulative tool-call ceiling. A run that needed longer and was
 * doing exactly what it had been asked to do was stopped, and everything it had
 * gathered was thrown away — which is what happened to a competitor sweep after
 * eleven minutes of research.
 *
 * Duration is the wrong question. The right one is whether this workspace may
 * keep working, and that is the one money authority's to answer: Operating
 * Units, suspension, billing suspension, a paused team, a kill switch. The
 * runtime READS that verdict and never forms its own opinion about a balance
 * (INV-PB-010).
 *
 * What is left is a STUCK test, which is not a duration limit: a chain that
 * continues without advancing is a defect draining an account, and stopping it
 * serves the person better than spending the rest of their balance on it.
 */
import { assessContinuation, hasAdvanced } from '../run-continuation-handler';

const allowed = () => Promise.resolve({ allowed: true as const });
const denied = (reason: string, detail: string) =>
  () => Promise.resolve({ allowed: false as const, reason, detail, quotaType: reason } as never);

const at = (cursor: string, stepOutputCount = 0, loopIndex: number | null = null) =>
  ({ cursor, stepOutputCount, loopIndex });

describe('the cap is the spend', () => {
  it('lets a long run continue far past the old six-continuation bound', async () => {
    const v = await assessContinuation({
      admit: allowed, depth: 40, cumulativeToolCalls: 20_000,
      previousProgress: at('s7'), progress: at('s8'),
    });
    expect(v.ok).toBe(true);
  });

  it('stops when the money authority says no, in its words', async () => {
    const v = await assessContinuation({
      admit: denied('billing_suspended', 'Tenant is suspended for billing'),
      depth: 1, cumulativeToolCalls: 1, progress: at('s2'),
    });
    expect(v.ok).toBe(false);
    expect((v as { error: string }).error).toContain('suspended for billing');
  });

  it.each([
    ['operational_status', 'Tenant is suspended'],
    ['agent_execution', 'Agent execution is not allowed'],
    ['kill_switch', 'Workflow execution is disabled'],
  ])('relays the %s verdict rather than re-deciding it', async (reason, detail) => {
    const v = await assessContinuation({
      admit: denied(reason, detail), depth: 1, cumulativeToolCalls: 1, progress: at('s2'),
    });
    expect(v.ok).toBe(false);
    expect((v as { error: string }).error).toContain(detail);
  });

  it('asks admission BEFORE any other bound, so the reason a person reads is the real one', async () => {
    // A stuck chain in a suspended workspace is suspended first: "you are out
    // of Operating Units" is actionable and "it made no progress" is not.
    const v = await assessContinuation({
      admit: denied('billing_suspended', 'Tenant is suspended for billing'),
      depth: 1, cumulativeToolCalls: 1,
      previousProgress: at('s7'), progress: at('s7'), nonAdvancing: 9,
    });
    expect((v as { error: string }).error).toContain('suspended for billing');
  });
});

describe('progress, not the clock', () => {
  it('a moved cursor is progress', () => {
    expect(hasAdvanced(at('s7'), at('s8'))).toBe(true);
  });

  it('a new step output is progress even on the same cursor', () => {
    expect(hasAdvanced(at('s7', 3), at('s7', 4))).toBe(true);
  });

  it('a consumed LOOP item is progress, which is why the cursor alone cannot be the test', () => {
    // A loop parks on its own step by design, so every continuation of a
    // hundred-item loop reports the same cursor while progressing perfectly.
    expect(hasAdvanced(at('s7', 3, 10), at('s7', 3, 11))).toBe(true);
  });

  it('nothing moving is not progress', () => {
    expect(hasAdvanced(at('s7', 3, 10), at('s7', 3, 10))).toBe(false);
  });

  it('the first continuation always counts as progress', () => {
    expect(hasAdvanced(null, at('s1'))).toBe(true);
  });
});

describe('the stuck bound', () => {
  const stuck = (nonAdvancing: number) => assessContinuation({
    admit: allowed, depth: 1, cumulativeToolCalls: 1,
    previousProgress: at('s7', 3, 10), progress: at('s7', 3, 10), nonAdvancing,
  });

  it('tolerates one or two non-advancing continuations', async () => {
    // A single step slower than a whole invocation legitimately parks without
    // advancing anything.
    expect((await stuck(0)).ok).toBe(true);
    expect((await stuck(1)).ok).toBe(true);
  });

  it('stops a chain that has not moved three times running', async () => {
    const v = await stuck(2);
    expect(v.ok).toBe(false);
    expect((v as { error: string }).error).toMatch(/made no progress/);
    expect((v as { error: string }).error).toContain('s7');
  });

  it('resets the streak the moment the chain moves', async () => {
    const v = await assessContinuation({
      admit: allowed, depth: 1, cumulativeToolCalls: 1,
      previousProgress: at('s7'), progress: at('s8'), nonAdvancing: 2,
    });
    expect(v).toMatchObject({ ok: true, nonAdvancing: 0 });
  });

  it('counts up while it stays still', async () => {
    expect(await stuck(0)).toMatchObject({ nonAdvancing: 1 });
    expect(await stuck(1)).toMatchObject({ nonAdvancing: 2 });
  });
});

describe('the operator backstops', () => {
  it('do not bound a progressing run when unset', async () => {
    const v = await assessContinuation({
      admit: allowed, depth: 1_000, cumulativeToolCalls: 1_000_000,
      previousProgress: at('s7'), progress: at('s8'),
    });
    expect(v.ok).toBe(true);
  });
});
