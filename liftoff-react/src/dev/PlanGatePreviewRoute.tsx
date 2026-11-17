// Dev-only preview of the launch-time payment gate (PlanGate, ADR-050).
//
// The modal is normally unreachable on a developer's machine. It opens only
// when the server answers 402, and the server answers 402 only when
// `entitlements.agent_execution_allowed` is false for the tenant. A dev
// workspace on api-dev is entitled, so pressing Launch simply succeeds and the
// gate never renders.
//
// This route mounts the REAL <PlanGateProvider /> and drives it through its
// real public entry point, `openIfPaymentRequired`, with a real ApiError
// carrying status 402. Nothing here is copied or stubbed: the 402-keying, the
// reason extraction, PlanStep mounted without its Skip control, and the handoff
// to SubscribePaymentPanel all run exactly as they do in production. If this
// route renders it, /dashboard/agents and /dashboard/agents/build render it.
//
// The reasons below are the verbatim strings the server's guard produces
// (platform-backend src/billing/execution-guard.ts). That is the part worth
// previewing: the modal displays the guard's own copy, not its own, so the
// three refusal states read differently and only one of them is the
// skipped-the-plan-step case.
//
// Selecting a self-serve plan swaps PlanStep for the real
// <SubscribePaymentPanel />, which talks to dev Stripe in test mode. Do not
// complete a subscription here unless you intend to create one on the dev
// tenant.
//
// This file is only loaded under `import.meta.env.DEV` (see App.tsx). The
// conditional lazy() construction there tree-shakes the entire module, chunk
// included, out of production builds.

import { useEffect } from 'react'
import { PlanGateProvider, } from '../components/Dashboard/PlanGate'
import { usePlanGate } from '../components/Dashboard/planGateContext'
import { ApiError } from '../services/api'

/** Verbatim guard copy, one entry per branch of checkExecutionAllowed. */
const GUARD_REASONS: { label: string; note: string; reason: string }[] = [
  {
    label: 'No plan',
    note: 'The workspace skipped the plan step during onboarding. No subscription, no card.',
    reason:
      'This workspace needs an active plan before agents can run. Please subscribe to a plan to continue.',
  },
  {
    label: 'Outstanding balance',
    note: 'Post-pay workspace suspended for an unpaid balance.',
    reason:
      'Workspace has an outstanding balance of $128.40. Please update your payment method.',
  },
  {
    label: 'No credit',
    note: 'Pre-pay workspace whose wallet reached zero.',
    reason: 'Your credit balance is $0. Please add credit to continue.',
  },
]

const page: React.CSSProperties = {
  minHeight: '100vh',
  padding: '48px 24px',
  background: 'var(--bg-light)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--color-black)',
}

const panel: React.CSSProperties = {
  maxWidth: '640px',
  margin: '0 auto',
  padding: '24px',
  background: 'var(--bg-card)',
  border: '1px solid var(--border-medium)',
  borderRadius: '12px',
  boxShadow: 'var(--shadow-sm)',
}

const button: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '12px 14px',
  marginTop: '10px',
  background: 'var(--color-white)',
  border: '1px solid var(--border-medium)',
  borderRadius: '8px',
  cursor: 'pointer',
  // Custom buttons drift heavier than body text without these three.
  fontFamily: 'var(--font-sans)',
  fontVariationSettings: '"wght" 400',
  letterSpacing: 'normal',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-black)',
}

function PlanGatePreview() {
  const { openIfPaymentRequired } = usePlanGate()

  // Open the skipped-the-plan-step case on arrival, which is the state this
  // route exists to show. `openIfPaymentRequired` is a stable useCallback, so
  // this fires once.
  useEffect(() => {
    openIfPaymentRequired(new ApiError(GUARD_REASONS[0].reason, 402))
  }, [openIfPaymentRequired])

  return (
    <div style={page}>
      <div style={panel}>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>Plan gate preview</h1>
        <p style={{ color: 'var(--color-gray-400)', fontSize: 'var(--text-sm)' }}>
          Dev only. Each button hands the real provider a real 402, which is the only
          thing that opens this modal in production. Close the modal to return here.
        </p>
        {GUARD_REASONS.map((r) => (
          <button
            key={r.label}
            type="button"
            style={button}
            onClick={() => openIfPaymentRequired(new ApiError(r.reason, 402))}
          >
            <strong>{r.label}</strong>
            <span style={{ display: 'block', color: 'var(--color-gray-400)' }}>{r.note}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function PlanGatePreviewRoute() {
  return (
    <PlanGateProvider>
      <PlanGatePreview />
    </PlanGateProvider>
  )
}
