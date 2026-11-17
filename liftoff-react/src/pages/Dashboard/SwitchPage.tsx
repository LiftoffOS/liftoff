// Route wrapper for /dashboard/switch/:source[/:stage].
//
// Authenticated only. A logged-out visit goes through the standard login or
// signup redirect and returns to this same route with the source intact, so a
// link into the wizard survives sign-in.

import { Navigate, useParams } from 'react-router'
import SwitchWizard from './SwitchWizard/SwitchWizard'
import type { MigrationSource } from '../../services/sourceMigrations'

const SUPPORTED: MigrationSource[] = ['openclaw', 'hermes']

export default function SwitchPage() {
  const { source } = useParams<{ source?: string }>()

  // DeerFlow, Omnigent and Agno are deferred; an unknown source goes to the
  // connect page rather than rendering an import for something we cannot read.
  if (!source || !SUPPORTED.includes(source as MigrationSource)) {
    return <Navigate to="/dashboard/agents/connect" replace />
  }

  return <SwitchWizard source={source as MigrationSource} />
}
