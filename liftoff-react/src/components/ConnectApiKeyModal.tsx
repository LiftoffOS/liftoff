import { useState, useEffect } from 'react'
import Button from './Button'
import ModalOverlay from './ModalOverlay'
// One rendering for a connection's credential fields, shared with the custom
// API capture page so the two places a person types a key look and behave the
// same.
import ConnectionCredentialField from './ConnectionCredentialField'
import { useApiKeyConnect, type ApiKeyField } from '../hooks/useApiKeyConnect'
import type { Integration } from '../hooks/useIntegrations'

interface ConnectApiKeyModalProps {
  integration: Integration
  onClose: () => void
  onSuccess?: () => void
}

export default function ConnectApiKeyModal({
  integration,
  onClose,
  onSuccess,
}: ConnectApiKeyModalProps) {
  const { connect, connecting, fetchFieldConfig, fieldConfig, steps, description, loadingConfig } = useApiKeyConnect({
    onSuccess,
  })
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [currentStep, setCurrentStep] = useState(0)

  // Back to the first step whenever the connector changes, compared during
  // render; fetching its field config stays an effect, which is what effects
  // are for.
  const [stepConnectorType, setStepConnectorType] = useState(integration.connectorType)
  if (integration.connectorType !== stepConnectorType) {
    setStepConnectorType(integration.connectorType)
    setCurrentStep(0)
  }

  useEffect(() => {
    if (integration.connectorType) fetchFieldConfig(integration.connectorType)
  }, [integration.connectorType, fetchFieldConfig])

  // Multi-step forms are opt-in via the connector config's `steps`. Without it,
  // this renders exactly as before: one step, all fields, a single [Save].
  const isMultiStep = (steps?.length ?? 0) > 1
  const totalSteps = steps?.length ?? 1
  const isLastStep = currentStep >= totalSteps - 1
  const visibleFields = isMultiStep
    ? (fieldConfig ?? []).filter(field => (field.step ?? 0) === currentStep)
    : fieldConfig ?? []

  const handleChange = (fieldName: string, value: string) => {
    setValues(prev => ({ ...prev, [fieldName]: value }))
    if (errors[fieldName]) {
      setErrors(prev => {
        const next = { ...prev }
        delete next[fieldName]
        return next
      })
    }
  }

  const validateFields = (fields: ApiKeyField[]): Record<string, string> => {
    const newErrors: Record<string, string> = {}
    for (const field of fields) {
      if (field.required && !values[field.name]?.trim()) {
        newErrors[field.name] = `${field.label} is required`
      }
    }
    return newErrors
  }

  const handleContinue = () => {
    const stepErrors = validateFields(visibleFields)
    setErrors(stepErrors)
    if (Object.keys(stepErrors).length === 0) {
      setCurrentStep(step => step + 1)
    }
  }

  const handleSave = async () => {
    if (!fieldConfig || !integration.connectorType) return
    // Validate every field across all steps. If a required field on an earlier
    // step is somehow empty, surface the error and jump back to that step.
    const allErrors = validateFields(fieldConfig)
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors)
      if (isMultiStep) {
        const erroredSteps = fieldConfig.filter(f => allErrors[f.name]).map(f => f.step ?? 0)
        setCurrentStep(Math.min(...erroredSteps))
      }
      return
    }
    const success = await connect(integration.connectorType, values, integration.name, integration.connector?.id)
    if (success) {
      onClose()
    }
  }

  const handleClose = () => {
    if (!connecting) {
      onClose()
    }
  }

  const stepDescription = isMultiStep ? steps?.[currentStep]?.description : undefined
  const stepHelpUrl = isMultiStep ? steps?.[currentStep]?.helpUrl : undefined

  return (
    <ModalOverlay onClose={handleClose} disableClose={connecting}>
      <div className="connection-modal__icon">{integration.icon}</div>
      <h2 className="connection-modal__title">Connect {integration.name}</h2>

      {isMultiStep && steps && (
        <div className="connection-modal__step-header">
          <span className="connection-modal__step-indicator">
            Step {currentStep + 1} of {totalSteps}
          </span>
          <h3 className="connection-modal__step-title">{steps[currentStep]?.title}</h3>
        </div>
      )}

      <p className="connection-modal__description">
        {stepDescription ??
          description ??
          `Connect your ${integration.name} account to give your agents access to this app. Paste your API key to continue.`}
      </p>

      {loadingConfig ? (
        <div className="connection-modal__spinner">
          <div className="loading-spinner" role="status" aria-label="Loading connection form" />
        </div>
      ) : fieldConfig ? (
        <div className="connection-modal__fields">
          {visibleFields.map(field => (
            <ConnectionCredentialField
              key={field.name}
              field={field}
              value={values[field.name] || ''}
              onChange={val => handleChange(field.name, val)}
              error={errors[field.name]}
              disabled={connecting}
              idPrefix="apikey"
            />
          ))}
        </div>
      ) : (
        <p className="connection-modal__description">
          Unable to load configuration for this connector.
        </p>
      )}

      {stepHelpUrl && (
        <p className="connection-modal__help-link">
          <a href={stepHelpUrl} target="_blank" rel="noopener noreferrer">More Info</a>
        </p>
      )}

      <div className="connection-modal__actions">
        <Button variant="outline" onClick={handleClose} disabled={connecting}>
          Cancel
        </Button>
        {isLastStep ? (
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={connecting || !fieldConfig}
            loading={connecting}
          >
            {connecting ? 'Saving...' : 'Save'}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={handleContinue}
            disabled={connecting || !fieldConfig}
          >
            Continue
          </Button>
        )}
      </div>
    </ModalOverlay>
  )
}
