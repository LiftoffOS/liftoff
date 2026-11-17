/**
 * Analytics — removed.
 *
 * This deployment sends no telemetry anywhere. There is no GA4, no PostHog, no
 * measurement id and no vendor SDK in the bundle: the functions below do
 * nothing and return immediately.
 *
 * WHY A SHIM RATHER THAN DELETING THE CALLS. 154 files call these, almost
 * always one line inside a handler that does something else. Removing the
 * calls would mean touching every one of those files to delete a line, which
 * is a large diff through code that has nothing to do with analytics and a
 * real chance of taking a neighbouring line with it. The shim is one file and
 * the behaviour is identical.
 *
 * THE TYPES ARE KEPT ON PURPOSE. `track` is still generic over
 * AnalyticsEventMap, so a call site still has to name a real event and pass
 * the properties that event declares. That keeps the call sites meaningful
 * documentation of what the product considers worth noticing, keeps them
 * honest if telemetry is ever added back, and means removing analytics did not
 * quietly turn 154 type-checked calls into `any`.
 *
 * If a deployment wants telemetry, implement these seven functions against
 * whatever it uses. Nothing else in the app needs to change, and consent is
 * that deployment's decision to design — which is why the cookie banner went
 * with the vendors rather than being left behind asking about nothing.
 */

import type {
  AnalyticsEventMap,
  AnalyticsEventName,
  FusedOnboardingEventName,
} from './analytics-events'

// Copied verbatim from the implementation these replace. Narrowing them would
// turn "analytics removed" into a type error at an unrelated call site, which is
// how a no-op shim stops being a no-op.
interface IdentifyArgs {
  accountId: string
  email: string
  firstName?: string
  lastName?: string
  persona?: string | null
  timezone?: string
  isInternal?: boolean
}

interface TenantContextArgs {
  tenantId: string
  tenantName: string
  tenantRole: string
}

export function initAnalytics(): void {}

export function trackPageView(_path: string): void {}

export function identifyUser(_args: IdentifyArgs): void {}

export function updateTenantContext(_args: TenantContextArgs): void {}

export function resetAnalytics(): void {}

export function track<E extends AnalyticsEventName>(
  _event: E,
  _properties: AnalyticsEventMap[E],
): void {}

export function trackOnboarding<E extends FusedOnboardingEventName>(
  _event: E,
  _properties: AnalyticsEventMap[E],
): void {}
