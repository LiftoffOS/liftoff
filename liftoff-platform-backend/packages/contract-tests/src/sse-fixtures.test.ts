import {
  assertSseLifecycle,
  workforceDraftPlanLifecycleFixture,
} from './sse-fixtures.js';

describe('assertSseLifecycle', () => {
  const fixtureEvents = (workforceDraftPlanLifecycleFixture as { events: unknown[] }).events;

  it('canonical fixture passes all assertions', () => {
    const result = assertSseLifecycle(fixtureEvents);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a stream that does not begin with session_started', () => {
    const broken = fixtureEvents.slice(1);
    const result = assertSseLifecycle(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /first event/.test(e))).toBe(true);
  });

  it('rejects a stream whose proposedAgentCount disagrees', () => {
    const broken = fixtureEvents.filter(
      (e) => (e as { kind: string }).kind !== 'agent_proposed',
    );
    const result = assertSseLifecycle(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /proposedAgentCount/.test(e))).toBe(true);
  });

  it('rejects events that span multiple planIds', () => {
    const broken = [...fixtureEvents];
    broken[1] = { ...(broken[1] as object), planId: 'different-plan' };
    const result = assertSseLifecycle(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /multiple planId/.test(e))).toBe(true);
  });
});
