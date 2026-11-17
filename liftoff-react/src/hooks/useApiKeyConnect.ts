import { useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { useConnectors } from './useConnectors'
import { api } from '../services/api'
import type { ConnectorType } from '../services/connections'
import { track } from '../lib/analytics'

export interface FormStep {
  title: string
  description?: string
  /** Optional help-center link rendered as a "More Info" link inside the step. */
  helpUrl?: string
}

export interface ApiKeyField {
  name: string
  label: string
  // 'textarea' is a multi-line variant of 'text' — the connect modal renders it
  // as a <textarea> (for pasted PEM certificate/key blocks, e.g. ADP).
  type: 'text' | 'password' | 'select' | 'textarea'
  required: boolean
  placeholder: string
  // 0-based index into the config's `steps`; absent ⇒ step 0 (single-step form).
  step?: number
  // For type 'select': dropdown options (value = stored value).
  options?: Array<{ value: string; label: string }>
}

interface ApiKeyConfig {
  connectorType: string
  displayName: string
  // The sentence the modal shows above the fields, for a connector whose
  // credential is not an API key. Absent, the modal's own sentence.
  description?: string
  fields: ApiKeyField[]
  // Optional multi-step grouping for long forms; the modal paginates fields by `field.step`.
  steps?: FormStep[]
}

interface UseApiKeyConnectOptions {
  onSuccess?: () => void
}

export function useApiKeyConnect(options: UseApiKeyConnectOptions = {}) {
  const { currentTenant: tenant, tenantLoading } = useAuth()
  const { showToast } = useToast()
  const { refetch: refetchConnectors } = useConnectors()
  const [connecting, setConnecting] = useState(false)
  const [fieldConfig, setFieldConfig] = useState<ApiKeyField[] | null>(null)
  const [steps, setSteps] = useState<FormStep[] | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(false)

  const tenantId = tenant?.id

  const fetchFieldConfig = useCallback(async (connectorType: ConnectorType) => {
    setLoadingConfig(true)
    try {
      const config = await api.get<ApiKeyConfig>(`/api/connectors/apikey/${connectorType}/config`)
      setFieldConfig(config.fields)
      setSteps(config.steps ?? null)
      setDescription(config.description ?? null)
      return config.fields
    } catch {
      showToast('Failed to load connector configuration.', 'error')
      return null
    } finally {
      setLoadingConfig(false)
    }
  }, [showToast])

  const connect = useCallback(async (
    connectorType: ConnectorType,
    credentials: Record<string, string>,
    integrationName?: string,
    reconnectConnectorId?: string,
  ) => {
    if (!tenantId) {
      if (tenantLoading) {
        showToast('Loading workspace... Please wait a moment and try again.', 'error')
      } else {
        showToast('Workspace not ready. Please refresh the page.', 'error')
      }
      return false
    }

    try {
      setConnecting(true)
      await api.post(`/api/connectors/apikey/${connectorType}/connect`, {
        tenantId,
        ...credentials,
        ...(reconnectConnectorId ? { connectorId: reconnectConnectorId } : {}),
      })
      track('connection_api_key_submitted', { connector: connectorType, success: true })
      showToast(`Successfully connected ${integrationName ?? 'integration'}!`, 'success')
      refetchConnectors()
      options.onSuccess?.()
      return true
    } catch (error) {
      track('connection_api_key_submitted', { connector: connectorType, success: false })
      const message = (error instanceof Error && error.message) || 'Failed to connect. Please check your credentials and try again.'
      showToast(message, 'error')
      return false
    } finally {
      setConnecting(false)
    }
  }, [tenantId, tenantLoading, showToast, refetchConnectors, options])

  return {
    connect,
    connecting,
    fetchFieldConfig,
    fieldConfig,
    steps,
    description,
    loadingConfig,
    tenantReady: !tenantLoading && !!tenantId,
  }
}
