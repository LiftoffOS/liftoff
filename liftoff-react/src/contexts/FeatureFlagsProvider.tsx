import { useEffect, useState, type ReactNode } from 'react'
import { fetchAndActivate, getValue } from 'firebase/remote-config'
import { remoteConfig } from '../config/firebase'
import {
  FeatureFlagsContext,
  defaults,
  devLiftoffScoreOverride,
  type FeatureFlags,
} from './FeatureFlagsContext'

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<FeatureFlags>(defaults)

  useEffect(() => {
    fetchAndActivate(remoteConfig)
      .then(() => {
        setFlags({
          liftoffScoreEnabled:
            devLiftoffScoreOverride || getValue(remoteConfig, 'liftoff_score_enabled').asBoolean(),
        })
      })
      .catch(() => {
        // Silently fall back to defaults on fetch failure
      })
  }, [])

  return (
    <FeatureFlagsContext.Provider value={flags}>
      {children}
    </FeatureFlagsContext.Provider>
  )
}
