// Dev-only preview of the onboarding wizard.
//
// Renders the production <OnboardingPage /> with `previewMode` set so we can
// iterate on the UI without:
//   * being bounced by the inverse-completed gate (already-onboarded owners
//     can view every step),
//   * mutating the real tenant's workspace name / step / onboardingCompletedAt,
//   * mutating the real account's persona,
//   * sending real invitation emails via inviteToTenant.
//
// The payment step itself DOES render the real <SubscribePaymentPanel />
// against dev Stripe (test mode) so the Stripe-backed UI — including the
// promo-code field — is visible and exercisable. See PaymentStep in
// OnboardingPage.tsx: the previewMode short-circuit there only fires for
// enterprise plans. Stripe test mode is the safe localhost default and we
// never want to fall back to mocked card forms.
//
// This file is only loaded under `import.meta.env.DEV` (see App.tsx). The
// conditional lazy() construction in App.tsx ensures the entire module —
// including the chunk file — is tree-shaken from production builds.

import OnboardingPage from '../pages/Dashboard/OnboardingPage'

export default function OnboardingPreviewRoute() {
  return <OnboardingPage previewMode />
}
