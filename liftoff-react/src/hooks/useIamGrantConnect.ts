import { useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { useConnectors } from './useConnectors'
import { api } from '../services/api'
import type { ConnectorType } from '../services/connections'
import { track } from '../lib/analytics'

// Keyless IAM-grant connect flow (mirrors useKeypairConnect's setup→verify
// shape). Used by connectors whose catalog auth.kind === 'iam_grant': the
// backend provisions a per-tenant service account, returns a copy-paste IAM
// grant, and the tenant clicks Verify once they've applied it. Today the only
// such connector is BigQuery (per-tenant SA impersonation).

// connectorType → the connector-service router base (PB proxies /api/connectors/*
// verbatim). Only BigQuery exists today; add rows as more iam_grant connectors land.
const IAM_GRANT_ENDPOINTS: Record<string, string> = {
  google_bigquery: '/api/connectors/bigquery',
}

interface ConnectResponse {
  connectorId: string
  serviceAccountEmail: string
  grantInstructions: string
  status: 'active' | 'pending_grant'
  detail?: string
}

interface VerifyResponse {
  connectorId: string
  status: 'active' | 'pending_grant'
  detail?: string
}

interface UseIamGrantConnectOptions {
  onSuccess?: () => void
}

export function useIamGrantConnect(options: UseIamGrantConnectOptions = {}) {
  const { currentTenant: tenant, tenantLoading } = useAuth()
  const { showToast } = useToast()
  const { refetch: refetchConnectors } = useConnectors()
  const [submitting, setSubmitting] = useState(false)
  const [connectorId, setConnectorId] = useState<string | null>(null)
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string | null>(null)
  const [grantInstructions, setGrantInstructions] = useState<string | null>(null)

  const tenantId = tenant?.id

  const connect = useCallback(async (
    connectorType: ConnectorType,
    fields: Record<string, string>,
  ): Promise<'active' | 'pending_grant' | null> => {
    if (!tenantId) {
      showToast(tenantLoading ? 'Loading workspace...' : 'Workspace not ready.', 'error')
      return null
    }
    const base = IAM_GRANT_ENDPOINTS[connectorType]
    if (!base) {
      showToast('This connector does not support IAM-grant connect.', 'error')
      return null
    }
    try {
      setSubmitting(true)
      const response = await api.post<ConnectResponse>(`${base}/connect`, {
        tenantId,
        projectId: fields.projectId?.trim(),
        dataset: fields.dataset?.trim() || undefined,
      })
      setConnectorId(response.connectorId)
      setServiceAccountEmail(response.serviceAccountEmail)
      setGrantInstructions(response.grantInstructions)
      return response.status
    } catch (error) {
      showToast((error instanceof Error && error.message) || 'Connect failed. Please check your inputs.', 'error')
      return null
    } finally {
      setSubmitting(false)
    }
  }, [tenantId, tenantLoading, showToast])

  const verify = useCallback(async (
    connectorType: ConnectorType,
    integrationName?: string,
  ): Promise<'active' | 'pending_grant' | null> => {
    if (!tenantId || !connectorId) return null
    const base = IAM_GRANT_ENDPOINTS[connectorType]
    if (!base) return null
    try {
      setSubmitting(true)
      const response = await api.post<VerifyResponse>(`${base}/verify`, { tenantId, connectorId })
      if (response.status === 'active') {
        track('connection_iam_grant_submitted', { connector: connectorType, success: true })
        showToast(`Successfully connected ${integrationName ?? 'integration'}!`, 'success')
        refetchConnectors()
        options.onSuccess?.()
      } else {
        // Honest not-yet-reachable — the grant hasn't propagated / isn't applied.
        showToast('Access not verified yet. Make sure you ran the grant, then try again.', 'error')
      }
      return response.status
    } catch (error) {
      track('connection_iam_grant_submitted', { connector: connectorType, success: false })
      showToast((error instanceof Error && error.message) || 'Verification failed. Ensure the IAM grant is applied.', 'error')
      return null
    } finally {
      setSubmitting(false)
    }
  }, [tenantId, connectorId, showToast, refetchConnectors, options])

  return { connect, verify, submitting, connectorId, serviceAccountEmail, grantInstructions }
}
