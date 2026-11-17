import { useState } from 'react'
import Button from './Button'
import TextInput from './TextInput/TextInput'
import ModalOverlay from './ModalOverlay'
import { useKeypairConnect } from '../hooks/useKeypairConnect'
import type { Integration } from '../hooks/useIntegrations'

interface ConnectKeypairModalProps {
  integration: Integration
  onClose: () => void
  onSuccess?: () => void
}

type Step = 'fields' | 'publicKey'

const SNOWFLAKE_FIELDS = [
  { name: 'username', label: 'Snowflake Username', type: 'text' as const, required: true, placeholder: 'MY_USER' },
  { name: 'accountIdentifier', label: 'Account Identifier', type: 'text' as const, required: true, placeholder: 'xy12345.us-east-1' },
]

export default function ConnectKeypairModal({
  integration,
  onClose,
  onSuccess,
}: ConnectKeypairModalProps) {
  const { setup, verify, submitting, publicKey, instructions } = useKeypairConnect({ onSuccess })
  const [step, setStep] = useState<Step>('fields')
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleChange = (name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }))
    if (errors[name]) {
      setErrors(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}
    for (const field of SNOWFLAKE_FIELDS) {
      if (field.required && !values[field.name]?.trim()) {
        newErrors[field.name] = `${field.label} is required`
      }
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSetup = async () => {
    if (!validate() || !integration.connectorType) return
    const ok = await setup(integration.connectorType, values)
    if (ok) setStep('publicKey')
  }

  const handleVerify = async () => {
    if (!integration.connectorType) return
    const ok = await verify(integration.connectorType, integration.name)
    if (ok) onClose()
  }

  if (step === 'publicKey') {
    return (
      <ModalOverlay onClose={onClose} disableClose={submitting}>
        <div className="connection-modal__icon">{integration.icon}</div>
        <h2 className="connection-modal__title">Add Public Key to Snowflake</h2>
        <p className="connection-modal__description">
          Run the following command in your Snowflake worksheet to register the public key:
        </p>
        {instructions && (
          <pre className="connection-modal__code-block">{instructions}</pre>
        )}
        {publicKey && (
          <pre className="connection-modal__code-block connection-modal__code-block--key">{publicKey}</pre>
        )}
        <div className="connection-modal__actions">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleVerify} loading={submitting} disabled={submitting}>
            {submitting ? 'Verifying...' : "I've added the public key"}
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
        Connect your {integration.name} account to give your agents access to this app. Enter your account details. A keypair will be generated and you will register the public key in Snowflake.
      </p>
      <div className="connection-modal__fields">
        {SNOWFLAKE_FIELDS.map(field => (
          <TextInput
            key={field.name}
            id={`keypair-${field.name}`}
            label={field.label}
            type={field.type}
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
        <Button variant="primary" onClick={handleSetup} loading={submitting} disabled={submitting}>
          {submitting ? 'Generating keypair...' : 'Continue'}
        </Button>
      </div>
    </ModalOverlay>
  )
}
