// Which control wins when both are set.
//
// Two surfaces set an agent's oversight, and they are not equal partners:
//   /dashboard/oversight            sets the workspace default
//   /dashboard/agents/update         sets one agent's Autonomy Override
//
// The override wins for that agent; every other agent follows the workspace.
//
// This function exists because the override was shipped, stored on
// internal_agents.autonomy_override, and then ignored: all five consumers
// called getDefaultHitlLevel(oversight.autonomy) directly, so the runtime
// received the workspace value and the override was a control that recorded a
// setting and changed nothing. The bug was silent in both directions — the UI
// showed the override, and the agent kept gating at the workspace level.
import { getDefaultHitlLevel, resolveAgentHitlLevel } from '../types';

describe('resolveAgentHitlLevel', () => {
  it('uses the workspace default when the agent has no override', () => {
    expect(resolveAgentHitlLevel(null, 'autonomous')).toBe(4);
    expect(resolveAgentHitlLevel(undefined, 'controlled')).toBe(2);
  });

  it('lets one agent sit below a permissive workspace', () => {
    // The case that motivated this: workspace autonomous, one agent pulled back.
    expect(resolveAgentHitlLevel('controlled', 'autonomous')).toBe(2);
    expect(resolveAgentHitlLevel('balanced', 'autonomous')).toBe(3);
  });

  it('lets one agent sit above a restrictive workspace', () => {
    // The override is not a ceiling or a floor, it is a replacement.
    expect(resolveAgentHitlLevel('autonomous', 'controlled')).toBe(4);
  });

  it('agrees with the workspace mapping when the override matches it', () => {
    for (const tier of ['autonomous', 'balanced', 'controlled'] as const) {
      expect(resolveAgentHitlLevel(tier, tier)).toBe(getDefaultHitlLevel(tier));
    }
  });

  it('falls back to balanced when neither is set', () => {
    // Matches the previous `oversight?.autonomy ?? 'balanced'` default, so a
    // tenant with no oversight row behaves exactly as before.
    expect(resolveAgentHitlLevel(null, null)).toBe(getDefaultHitlLevel('balanced'));
    expect(resolveAgentHitlLevel(undefined, undefined)).toBe(3);
  });

  it('does not treat a null override as a value', () => {
    // A cleared override must hand control back to the workspace rather than
    // pinning the agent at whatever it was last set to.
    expect(resolveAgentHitlLevel(null, 'autonomous')).toBe(4);
    expect(resolveAgentHitlLevel(null, 'controlled')).toBe(2);
  });
});
