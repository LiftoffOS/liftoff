import { createContext, useContext } from 'react'

export interface FeatureFlags {
  liftoffScoreEnabled: boolean
}

// Dev-only escape hatch: run with VITE_LIFTOFF_SCORE_ENABLED=true to force the
// LiftoffScore section of the Insights report on locally (Remote Config is not
// served in `dev:mock`). Ignored outside `import.meta.env.DEV`. Ships off: it rates named people, so it stays dark until the backend serves
// real scores and the rollout is signed off.
export const devLiftoffScoreOverride =
  import.meta.env.DEV && import.meta.env.VITE_LIFTOFF_SCORE_ENABLED === 'true'

export const defaults: FeatureFlags = {
  liftoffScoreEnabled: devLiftoffScoreOverride,
}

export const FeatureFlagsContext = createContext<FeatureFlags>(defaults)

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext)
}
