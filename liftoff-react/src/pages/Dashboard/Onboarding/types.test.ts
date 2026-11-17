import { describe, it, expect } from 'vitest'
import {
  PATH_A_STEPS,
  PATH_B_STEPS,
  nextStepId,
  prevStepId,
  isStepInPath,
  pathOrdinal,
  completionDestination,
} from './types'

// ADR-050 reshaped the wizard: the first hire left onboarding, so hire_gallery,
// hire_confirm and provisioning are no longer steps. `all_set` has since gone
// too -- `invite` is the terminal step, and both of its exits (Continue, and
// the skip modal's CTA) end the wizard. Both paths run the same six, and
// `path` survives only to pick where completion lands.
const EXPECTED_STEPS = [
  'welcome',
  'workspace_name',
  'persona',
  'plan',
  'payment',
  'invite',
]

describe('PATH_A_STEPS / PATH_B_STEPS', () => {
  it('Path A contains every step in the expected linear order', () => {
    expect(PATH_A_STEPS).toEqual(EXPECTED_STEPS)
  })

  it('Path B runs the same steps in the same order', () => {
    expect(PATH_B_STEPS).toEqual(EXPECTED_STEPS)
  })

  // The three ids the hire flow used are gone from the union entirely
  // (migration 366, after 365 rewrote every row that held one). Asserted as
  // plain strings so this keeps working as a guard even though the type can no
  // longer express them.
  it('contains none of the retired hire steps', () => {
    for (const retired of ['hire_gallery', 'hire_confirm', 'provisioning']) {
      expect(PATH_A_STEPS).not.toContain(retired)
      expect(PATH_B_STEPS).not.toContain(retired)
    }
  })
})

describe('nextStepId', () => {
  it('advances forward through Path A', () => {
    expect(nextStepId('A', 'welcome')).toBe('workspace_name')
    expect(nextStepId('A', 'workspace_name')).toBe('persona')
    expect(nextStepId('A', 'persona')).toBe('plan')
    expect(nextStepId('A', 'plan')).toBe('payment')
    expect(nextStepId('A', 'payment')).toBe('invite')
  })

  it('advances forward through Path B identically', () => {
    expect(nextStepId('B', 'welcome')).toBe('workspace_name')
    expect(nextStepId('B', 'persona')).toBe('plan')
    expect(nextStepId('B', 'payment')).toBe('invite')
  })

  // `invite` is terminal, so there is nothing to advance to. Saturating rather
  // than returning undefined is what keeps a stray goNext() on the last step
  // from blanking the wizard.
  it('saturates at invite on either path', () => {
    expect(nextStepId('A', 'invite')).toBe('invite')
    expect(nextStepId('B', 'invite')).toBe('invite')
  })

  // The retired terminal step must be treated as unrecognised, exactly like
  // hire_gallery: returned unchanged so the gate can rescue the tenant rather
  // than silently resolving it to a neighbour.
  it('treats the retired all_set as unrecognised', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(nextStepId('A', 'all_set' as any)).toBe('all_set')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(prevStepId('B', 'all_set' as any)).toBe('all_set')
  })

  it('returns the input step unchanged when step is not in the path (defensive)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(nextStepId('A', 'bogus' as any)).toBe('bogus')
  })

  // A value the path array does not contain must be returned unchanged rather
  // than resolved to some neighbour. That is what stops a corrupt or
  // out-of-date step id from silently advancing someone into the wrong screen;
  // the gate is what rescues them, by seeing isStepInPath() === false.
  it('returns an unrecognised step unchanged rather than guessing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(nextStepId('A', 'hire_gallery' as any)).toBe('hire_gallery')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(prevStepId('B', 'provisioning' as any)).toBe('provisioning')
  })
})

describe('prevStepId', () => {
  it('walks backward through Path A', () => {
    expect(prevStepId('A', 'invite')).toBe('payment')
    expect(prevStepId('A', 'payment')).toBe('plan')
    expect(prevStepId('A', 'plan')).toBe('persona')
    expect(prevStepId('A', 'persona')).toBe('workspace_name')
    expect(prevStepId('A', 'workspace_name')).toBe('welcome')
  })

  it('walks backward through Path B identically', () => {
    expect(prevStepId('B', 'invite')).toBe('payment')
    expect(prevStepId('B', 'persona')).toBe('workspace_name')
  })

  it('saturates at welcome on either path', () => {
    expect(prevStepId('A', 'welcome')).toBe('welcome')
    expect(prevStepId('B', 'welcome')).toBe('welcome')
  })
})

describe('isStepInPath', () => {
  it('returns true for steps in their declared path', () => {
    expect(isStepInPath('A', 'persona')).toBe(true)
    expect(isStepInPath('B', 'invite')).toBe(true)
  })

  it('returns false for steps not in the declared path (impossible value)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isStepInPath('A', 'bogus' as any)).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isStepInPath('B', 'bogus' as any)).toBe(false)
  })

  // The property that rescues a tenant holding a step the wizard cannot render.
  // Migration 365 rewrote every such row and 366 removed the ids, so this now
  // guards against corrupt data rather than a known migration state — but it is
  // the same mechanism either way.
  it('returns false for any step the path does not contain', () => {
    for (const gone of ['hire_gallery', 'hire_confirm', 'provisioning']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isStepInPath('A', gone as any)).toBe(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isStepInPath('B', gone as any)).toBe(false)
    }
  })

  it('handles overlap correctly — workspace_name is in BOTH paths', () => {
    expect(isStepInPath('A', 'workspace_name')).toBe(true)
    expect(isStepInPath('B', 'workspace_name')).toBe(true)
  })
})

describe('pathOrdinal', () => {
  it('returns 1-based position for path A steps', () => {
    expect(pathOrdinal('A', 'welcome')).toBe(1)
    expect(pathOrdinal('A', 'workspace_name')).toBe(2)
    expect(pathOrdinal('A', 'persona')).toBe(3)
    expect(pathOrdinal('A', 'plan')).toBe(4)
    expect(pathOrdinal('A', 'payment')).toBe(5)
    expect(pathOrdinal('A', 'invite')).toBe(6)
  })

  it('returns the same 1-based positions for path B', () => {
    expect(pathOrdinal('B', 'welcome')).toBe(1)
    expect(pathOrdinal('B', 'plan')).toBe(4)
    expect(pathOrdinal('B', 'invite')).toBe(6)
  })

  it('returns 0 for unknown step ids so callers can filter', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(pathOrdinal('A', 'bogus' as any)).toBe(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(pathOrdinal('B', 'bogus' as any)).toBe(0)
  })

  it('Path A and Path B both terminate at ordinal 6 (same step count)', () => {
    expect(pathOrdinal('A', 'invite')).toBe(6)
    expect(pathOrdinal('B', 'invite')).toBe(6)
    expect(PATH_A_STEPS.length).toBe(PATH_B_STEPS.length)
  })

  // The retired step must score 0, not 7 -- a funnel that still charted it
  // would show a phantom final stage nobody can reach.
  it('scores the retired all_set as unknown', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(pathOrdinal('A', 'all_set' as any)).toBe(0)
  })
})

describe('completionDestination', () => {
  // Path A creates no team during onboarding any more, so the teams list would
  // greet a brand-new customer with its empty state. /dashboard is the chat
  // surface and reads correctly with nothing built yet.
  it('sends Path A to the dashboard home, not the teams list', () => {
    expect(completionDestination('A', null)).toBe('/dashboard')
  })

  it('ignores a stray hero role on Path A', () => {
    // Only a Path B tenant arrived from the hero. A role left in sessionStorage
    // from an earlier visit must not redirect a Path A user into the gallery.
    expect(completionDestination('A', 'Sales Engineer')).toBe('/dashboard')
  })

  it('sends Path B to the gallery with the hero role prefilled', () => {
    expect(completionDestination('B', 'Sales Engineer'))
      .toBe('/dashboard/agents/explore?role=Sales%20Engineer')
  })

  it('encodes a role containing URL-significant characters', () => {
    expect(completionDestination('B', 'R&D / Ops'))
      .toBe('/dashboard/agents/explore?role=R%26D%20%2F%20Ops')
  })

  // Losing the role (new tab, cleared storage) degrades to the plain gallery
  // rather than producing `?role=null`.
  it('sends Path B to the plain gallery when the role was lost', () => {
    expect(completionDestination('B', null)).toBe('/dashboard/agents/explore')
  })
})
