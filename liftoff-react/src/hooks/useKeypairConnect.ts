import { useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { useConnectors } from './useConnectors'
import { api } from '../services/api'
import type { ConnectorType } from '../services/connections'
import { track } from '../lib/analytics'

interface SetupResponse {
  publicKey: string
  instructions: string
  setupToken: string
}

interface UseKeypairConnectOptions {
  onSuccess?: () => void
}

export function useKeypairConnect(options: UseKeypairConnectOptions = {}) {
  const { currentTenant: tenant, tenantLoading } = useAuth()
  const { showToast } = useToast()
  const { refetch: refetchConnectors } = useConnectors()
  const [submitting, setSubmitting] = useState(false)
  const [setupToken, setSetupToken] = useState<string | null>(null)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [instructions, setInstructions] = useState<string | null>(null)

  const tenantId = tenant?.id

  const setup = useCallback(async (
    connectorType: ConnectorType,
    fields: Record<string, string>,
  ): Promise<boolean> => {
    if (!tenantId) {
      showToast(tenantLoading ? 'Loading workspace...' : 'Workspace not ready.', 'error')
      return false
    }
    try {
      setSubmitting(true)
      const response = await api.post<SetupResponse>(
        `/api/connectors/keypair/${connectorType}/setup`,
        { tenantId, ...fields },
      )
      setPublicKey(response.publicKey)
      setInstructions(response.instructions)
      setSetupToken(response.setupToken)
      return true
    } catch (error) {
      showToast((error instanceof Error && error.message) || 'Setup failed. Please check your inputs.', 'error')
      return false
    } finally {
      setSubmitting(false)
    }
  }, [tenantId, tenantLoading, showToast])

  const verify = useCallback(async (
    connectorType: ConnectorType,
    integrationName?: string,
  ): Promise<boolean> => {
    if (!tenantId || !setupToken) return false
    try {
      setSubmitting(true)
      await api.post(`/api/connectors/keypair/${connectorType}/verify`, {
        tenantId,
        setupToken,
      })
      track('connection_keypair_submitted', { connector: connectorType, success: true })
      showToast(`Successfully connected ${integrationName ?? 'integration'}!`, 'success')
      refetchConnectors()
      options.onSuccess?.()
      return true
    } catch (error) {
      track('connection_keypair_submitted', { connector: connectorType, success: false })
      showToast((error instanceof Error && error.message) || 'Verification failed. Make sure you added the public key in the service.', 'error')
      return false
    } finally {
      setSubmitting(false)
    }
  }, [tenantId, setupToken, showToast, refetchConnectors, options])

  return { setup, verify, submitting, publicKey, instructions }
}
