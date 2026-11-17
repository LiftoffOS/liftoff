import { useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useUpdateAccount } from './useAccount'

// Export constants for consistency (addresses FE-004)
export const GETTING_STARTED_HIDDEN_KEY = 'liftoff_getting_started_hidden'
export const GETTING_STARTED_REMIND_LATER_KEY = 'liftoff_getting_started_remind_later'
const MIGRATION_VERSION_KEY = 'liftoff_getting_started_v2_migrated'

export function useGettingStartedPreference() {
  const { account } = useAuth()
  const { mutateAsync: updateAccount, isPending } = useUpdateAccount()  // Use existing hook (FE-001)
  const hasMigrated = useRef(false)

  // Derive loading state (addresses FE-006)
  const isLoading = account === null

  // Read preference: backend takes precedence, then localStorage fallback
  const isHidden = account?.preferences?.gettingStartedHidden === true
    || localStorage.getItem(GETTING_STARTED_HIDDEN_KEY) === 'true'

  // One-time migration (addresses FE-005 with version flag)
  useEffect(() => {
    if (!account || hasMigrated.current) return
    if (localStorage.getItem(MIGRATION_VERSION_KEY)) return // Already migrated

    hasMigrated.current = true
    const localValue = localStorage.getItem(GETTING_STARTED_HIDDEN_KEY)
    const backendValue = account.preferences?.gettingStartedHidden

    if (localValue === 'true' && !backendValue) {
      updateAccount({ preferences: { gettingStartedHidden: true } })
        .then(() => localStorage.setItem(MIGRATION_VERSION_KEY, 'true'))
        .catch(console.warn)
    } else {
      localStorage.setItem(MIGRATION_VERSION_KEY, 'true')
    }
  }, [account, updateAccount])

  const hideGettingStarted = async () => {
    // Optimistic: set localStorage immediately
    localStorage.setItem(GETTING_STARTED_HIDDEN_KEY, 'true')

    try {
      await updateAccount({ preferences: { gettingStartedHidden: true } })
      // useUpdateAccount already calls refreshAccount on success
    } catch (error) {
      // Graceful degradation - localStorage already set
      console.warn('Failed to persist getting started preference:', error)
    }
  }

  return {
    isHidden,
    isLoading,
    hideGettingStarted,
    isHiding: isPending,
  }
}
