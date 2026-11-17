import { useState } from 'react'
import Button from './Button'
import TextInput from './TextInput/TextInput'
import ModalOverlay from './ModalOverlay'
import { useIamGrantConnect } from '../hooks/useIamGrantConnect'
import type { Integration } from '../hooks/useIntegrations'

interface ConnectIamGrantModalProps {
  integration: Integration
  onClose: () => void
  onSuccess?: () => void
}

type Step = 'fields' | 'grant'

interface FieldDef {
  name: string
  label: string
  required: boolean
  placeholder: string
}

// Per-connector fields captured before provisioning (mirrors the keypair
// modal's SNOWFLAKE_FIELDS). BigQuery needs the GCP project the data lives in;
// dataset is optional (scopes discovery + a default for list/query).
const IAM_GRANT_FIELDS: Record<string, FieldDef[]> = {
  google_bigquery: [
    { name: 'projectId', label: 'GCP Project ID', required: true, placeholder: 'my-analytics-project' },
    { name: 'dataset', label: 'Default Dataset (optional)', required: false, placeholder: 'analytics' },
  ],
}

export default function ConnectIamGrantModal({
  integration,
  onClose,
  onSuccess,
}: ConnectIamGrantModalProps) {
  const { connect, verify, submitting, serviceAccountEmail, grantInstructions } = useIamGrantConnect({ onSuccess })
  const [step, setStep] = useState<Step>('fields')
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const fields = (integration.connectorType && IAM_GRANT_FIELDS[integration.connectorType]) || []

  const handleChange = (name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }))
    if (errors[name]) {
      setErrors(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}
    for (const field of fields) {
      if (field.required && !values[field.name]?.trim()) {
        newErrors[field.name] = `${field.label} is required`
      }
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleConnect = async () => {
    if (!validate() || !integration.connectorType) return
    const status = await connect(integration.connectorType, values)
    if (status === 'active') {
      onClose() // already reachable (grant pre-existing) — done
    } else if (status === 'pending_grant') {
      setStep('grant')
    }
  }

  const handleVerify = async () => {
    if (!integration.connectorType) return
    const status = await verify(integration.connectorType, integration.name)
    if (status === 'active') onClose()
  }

  if (step === 'grant') {
    return (
      <ModalOverlay onClose={onClose} disableClose={submitting}>
        <div className="connection-modal__icon">{integration.icon}</div>
        <h2 className="connection-modal__title">Grant {integration.name} access</h2>
        <p className="connection-modal__description">
          Grant the service account below read access to your project, then click Verify. No keys leave your environment.
        </p>
        {serviceAccountEmail && (
          <pre className="connection-modal__code-block connection-modal__code-block--key">{serviceAccountEmail}</pre>
        )}
        {grantInstructions && (
          <pre className="connection-modal__code-block">{grantInstructions}</pre>
        )}
        <div className="connection-modal__actions">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleVerify} loading={submitting} disabled={submitting}>
            {submitting ? 'Verifying...' : "I've granted access"}
          </Button>
        </div>
      </ModalOverlay>
    )
  }

  return (
    <ModalOverlay onClose={onClose} disableClose={submitting}>
      <div className="connection-modal__icon">{integration.icon}</div>
      <h2 className="connection-modal__title">Connect {integration.name}</h2>
      <p className="connection-modal__description">
        Connect your {integration.name} account to give your agents access to this app. Enter your project details; we'll create a dedicated service account for you to grant read access to.
      </p>
      <div className="connection-modal__fields">
        {fields.map(field => (
          <TextInput
            key={field.name}
            id={`iam-grant-${field.name}`}
            label={field.label}
            type="text"
            placeholder={field.placeholder}
            value={values[field.name] || ''}
            onChange={e => handleChange(field.name, e.target.value)}
            error={errors[field.name]}
            disabled={submitting}
            autoComplete="off"
          />
        ))}
      </div>
      <div className="connection-modal__actions">
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleConnect} loading={submitting} disabled={submitting}>
          {submitting ? 'Creating service account...' : 'Continue'}
        </Button>
      </div>
    </ModalOverlay>
  )
}
