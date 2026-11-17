import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'

/** The operator switches behind the platform browser, read from the control
 *  plane's feature flags.
 *
 *  Every workspace gets an agent browser on the platform's own key, so the
 *  pane affordance can no longer be decided from connectors alone. But it
 *  cannot be decided from nothing either: an operator can switch a vendor off
 *  estate-wide during an incident, or exclude one workspace, and a toggle
 *  that opens a browser the backend then refuses is the same broken affordance
 *  as no toggle at all.
 *
 *  Two platform vendors, each behind two keys, because the tenant runtime
 *  reads the same four and this has to give the same answer it does (see
 *  platformPaneVendor in the runtime's
 *  browser-sessions/session-vendor-connectors.ts): the browser is available
 *  while ANY platform vendor is on for this workspace.
 *    - `web_fetch_vendor_<vendor>` is the estate-wide kill-switch
 *    - `web_fetch_vendor_<vendor>_disabled` is the per-workspace one
 *
 *  The runtime also checks that it actually holds each vendor's key, which
 *  this cannot see. That check only ever narrows the answer, and a runtime
 *  with neither key is a deployment defect rather than a state to design the
 *  affordance around.
 */
const PLATFORM_VENDORS = ['steel', 'browser_use'] as const

/** ABSENT MEANS ON. The runtime's flag reader defaults an unset vendor flag to
 *  enabled (DEFAULT_ENABLED in its global-flags.ts), and flags only exist as
 *  rows once an operator creates one. Defaulting to off here would hide the
 *  browser from every workspace until somebody happened to create the flag. */
export function platformBrowserFromFlags(
  flags: Record<string, boolean> | undefined,
): boolean {
  if (!flags) return false
  return PLATFORM_VENDORS.some((vendor) => {
    if (flags[`web_fetch_vendor_${vendor}`] === false) return false
    return flags[`web_fetch_vendor_${vendor}_disabled`] !== true
  })
}

/** Whether the platform's own browser is available to this workspace.
 *
 *  Answers `false` while the flags are still loading, and that is deliberate:
 *  showing the affordance and withdrawing it a moment later is worse than
 *  showing it a moment late, and an agent bound to its own browser connector
 *  does not go through this path at all. */
export function usePlatformBrowser(tenantId: string | undefined) {
  const query = useQuery({
    queryKey: ['feature-flags', tenantId],
    queryFn: () => api.get<Record<string, boolean>>(`/api/feature-flags/tenant/${tenantId}`),
    enabled: !!tenantId,
    // Flags change when an operator flips one, which is rare and never urgent
    // enough to poll for. A long stale time keeps this off the hot path.
    staleTime: 5 * 60 * 1000,
  })
  return {
    isAvailable: platformBrowserFromFlags(query.data),
    isPending: query.isPending,
  }
}
