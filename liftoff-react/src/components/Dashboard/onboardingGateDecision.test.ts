import { describe, it, expect } from 'vitest'
import { decideGate, type GateInput } from './onboardingGateDecision'
import type { TenantWithRole } from '../../services/tenants'

// Helper: build a TenantWithRole with sensible defaults for fused-onboarding
// columns. Tests override the fields they care about.
function tenant(overrides: Partial<TenantWithRole> = {}): TenantWithRole {
  return {
    id: 'tenant-1',
    accountId: 'acc-1',
    name: 'Test Workspace',
    status: 'active',
    gcpProjectId: null,
    databaseName: null,
    migrationStatus: 'completed',
    hasCreatedInternalAgent: false,
    onboardingStep: 0,
    onboardingCompletedAt: null,
    onboardingPath: null,
    onboardingStepId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    role: 'owner',
    ...overrides,
  }
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    tenantLoading: false,
    currentTenant: tenant(),
    currentRole: 'owner',
    pathname: '/dashboard',
    ...overrides,
  }
}

describe('decideGate', () => {
  describe('loading and error states (precedence)', () => {
    it('returns show_loading while tenantLoading is true', () => {
      expect(decideGate(input({ tenantLoading: true }))).toEqual({ kind: 'show_loading' })
    })

    it('returns show_loading even when other fields would otherwise produce a different decision', () => {
      // tenantLoading wins over a fully-onboarded tenant.
      expect(decideGate(input({
        tenantLoading: true,
        currentTenant: tenant({ onboardingCompletedAt: '2026-01-01T00:00:00Z' }),
      }))).toEqual({ kind: 'show_loading' })
    })

    it('returns show_error when tenant loading finished but no tenant is resolved', () => {
      expect(decideGate(input({ currentTenant: null }))).toEqual({ kind: 'show_error' })
    })
  })

  describe('non-owner passthrough', () => {
    it.each(['admin', 'member', 'viewer'] as const)(
      'returns render_children for %s (no membership of unfinished onboarding)',
      (role) => {
        expect(decideGate(input({ currentRole: role }))).toEqual({ kind: 'render_children' })
      },
    )
  })

  describe('owner of a fully-onboarded tenant (legacy or fused)', () => {
    it('renders children when onboardingCompletedAt is set', () => {
      expect(decideGate(input({
        currentTenant: tenant({ onboardingCompletedAt: '2026-01-01T00:00:00Z' }),
      }))).toEqual({ kind: 'render_children' })
    })
  })

  describe('owner already inside /onboarding', () => {
    it('renders children so OnboardingPage owns the routing', () => {
      // Even if the gate would otherwise want to mark a path, the user is
      // already on the onboarding page. Don't double-redirect.
      expect(decideGate(input({
        pathname: '/onboarding',
        currentTenant: tenant({ onboardingPath: 'B' }),
      }))).toEqual({ kind: 'render_children' })
    })

    it('renders children even at /onboarding/anything-with-prefix', () => {
      expect(decideGate(input({ pathname: '/onboarding/preview' }))).toEqual({ kind: 'render_children' })
    })
  })

  describe('owner with no onboarding state yet', () => {
    // Path B used to be seeded straight to hire_gallery with the hero role
    // copied onto onboarding_hire_input. Both are gone (ADR-050): the hire
    // left onboarding, so B runs the same steps as A and the path only picks
    // the all_set CTA destination. Seeding a retired step here would mark the
    // tenant at a step no path contains and bounce it on the very next load.
    it('seeds Path B at welcome, carrying no hire input', () => {
      const decision = decideGate(input({
        currentTenant: tenant({ onboardingPath: 'B' }),
      }))
      expect(decision).toEqual({
        kind: 'mark_path_and_go_onboarding',
        path: 'B',
        stepId: 'welcome',
      })
    })

    // The decision must carry nothing that could be written back onto a hire
    // column — those are dropped in the follow-up release, and a writer would
    // 42703 in the deploy window. TenantWithRole no longer even declares them,
    // so this asserts the decision shape itself stays clean.
    it('never carries a hire seed on the decision', () => {
      const decision = decideGate(input({
        currentTenant: tenant({ onboardingPath: 'B' }),
      }))
      expect(decision).toEqual({
        kind: 'mark_path_and_go_onboarding',
        path: 'B',
        stepId: 'welcome',
      })
      expect(decision).not.toHaveProperty('preselectedRole')
    })

    it('seeds Path A welcome when tenant.onboardingPath is A', () => {
      expect(decideGate(input({
        currentTenant: tenant({ onboardingPath: 'A' }),
      }))).toEqual({
        kind: 'mark_path_and_go_onboarding',
        path: 'A',
        stepId: 'welcome',
      })
    })

    it('defensively seeds Path A welcome when tenant.onboardingPath is null (legacy backfill miss)', () => {
      // Should rarely happen — AuthContext writes path on provision — but
      // defensive default keeps the user moving instead of stalling.
      expect(decideGate(input())).toEqual({
        kind: 'mark_path_and_go_onboarding',
        path: 'A',
        stepId: 'welcome',
      })
    })
  })

  describe('owner mid-onboarding (path + step_id set)', () => {
    it('returns go_onboarding for a path-A step', () => {
      expect(decideGate(input({
        currentTenant: tenant({
          onboardingPath: 'A',
          onboardingStepId: 'persona',
        }),
      }))).toEqual({ kind: 'go_onboarding' })
    })

    it('returns go_onboarding for a path-B step', () => {
      expect(decideGate(input({
        currentTenant: tenant({
          onboardingPath: 'B',
          onboardingStepId: 'invite',
        }),
      }))).toEqual({ kind: 'go_onboarding' })
    })

    // ADR-050 removed the hire steps from both paths. A tenant parked on one
    // is exactly Paul's case: isStepInPath() is false, so the defensive branch
    // restarts them at the first step instead of routing to a screen the
    // wizard no longer renders. This is what migrates them with no SQL.
    it('restarts a tenant stranded on a retired hire step', () => {
      expect(decideGate(input({
        currentTenant: tenant({
          onboardingPath: 'A',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onboardingStepId: 'hire_gallery' as any,
        }),
      }))).toEqual({ kind: 'mark_path_and_go_onboarding', path: 'A', stepId: 'welcome' })
    })

    it('does NOT redirect when the user is already at /onboarding (let the page resume)', () => {
      // pathname check happens before the in-progress branch.
      expect(decideGate(input({
        pathname: '/onboarding',
        currentTenant: tenant({
          onboardingPath: 'B',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onboardingStepId: 'hire_confirm' as any,
        }),
      }))).toEqual({ kind: 'render_children' })
    })
  })

  describe('defensive fallback for corrupt step_id', () => {
    it('routes path A back to welcome when step_id is invalid for path A', () => {
      // 'hire_gallery' is valid for both paths, so use a value valid for B
      // but not A to trigger the corrupt branch. Path A starts:
      //   welcome → workspace_name → persona → hire_gallery → hire_confirm → ...
      // All those are in path A too — meaning a step_id can only be "invalid"
      // if it's missing from BOTH arrays. Simulate that with a cast.
      expect(decideGate(input({
        currentTenant: tenant({
          onboardingPath: 'A',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onboardingStepId: 'totally-bogus' as any,
        }),
      }))).toEqual({
        kind: 'mark_path_and_go_onboarding',
        path: 'A',
        stepId: 'welcome',
      })
    })

    // Both paths restart at welcome now — B no longer has a different first
    // step, because the hire it used to start with left onboarding.
    it('routes path B back to welcome when step_id is invalid for path B', () => {
      expect(decideGate(input({
        currentTenant: tenant({
          onboardingPath: 'B',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onboardingStepId: 'totally-bogus' as any,
        }),
      }))).toEqual({
        kind: 'mark_path_and_go_onboarding',
        path: 'B',
        stepId: 'welcome',
      })
    })
  })
})
