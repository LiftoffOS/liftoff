import { useState, useEffect } from 'react'
import XIcon from '../assets/icons/x.svg?react'
import ModalOverlay from './ModalOverlay'
import Button from './Button'
import { TextInput } from '.'
import { useToast } from '../contexts/ToastContext'
import { ApiError } from '../services/api'
import { useUpdateAutoReload, useDisableAutoReload } from '../hooks/useBilling'
import type { AutoReloadSettings } from '../services/billing'
import './AutoReloadModal.css'

// Kept equal to platform-backend's auto-reload-settings route and migration 542.
const MIN_THRESHOLD_USD = 1
const MIN_RELOAD_USD = 5

const THRESHOLD_TOO_LOW = `Balance threshold must be at least $${MIN_THRESHOLD_USD}.`
const RELOAD_TOO_LOW = `Reload amount must be at least $${MIN_RELOAD_USD}.`

// The reason platform-backend gives for refusing a save, passed on by liftoff-billing.
const SAVE_ERRORS: Record<string, string> = {
  thresholdUsd_must_be_at_least_1: THRESHOLD_TOO_LOW,
  amountUsd_must_be_at_least_5: RELOAD_TOO_LOW,
}

interface AutoReloadModalProps {
  cardLast4: string | null
  currentSettings: AutoReloadSettings | null
  onClose: () => void
}

export default function AutoReloadModal({ cardLast4, currentSettings, onClose }: AutoReloadModalProps) {
  const { showToast } = useToast()
  const updateMutation = useUpdateAutoReload()
  const disableMutation = useDisableAutoReload()

  const [thresholdInput, setThresholdInput] = useState(
    currentSettings?.thresholdUsd != null ? String(currentSettings.thresholdUsd) : '',
  )
  const [reloadInput, setReloadInput] = useState(
    currentSettings?.reloadAmountUsd != null ? String(currentSettings.reloadAmountUsd) : '',
  )

  const isPending = updateMutation.isPending || disableMutation.isPending
  const isEnabled = currentSettings?.enabled ?? false

  const thresholdValue = parseFloat(thresholdInput)
  const reloadValue = parseFloat(reloadInput)
  const isValid =
    thresholdInput !== '' && !isNaN(thresholdValue) && thresholdValue >= MIN_THRESHOLD_USD &&
    reloadInput !== '' && !isNaN(reloadValue) && reloadValue >= MIN_RELOAD_USD

  useEffect(() => {
    if (thresholdInput === '') return
    const t = setTimeout(() => {
      if (isNaN(thresholdValue) || thresholdValue < MIN_THRESHOLD_USD) {
        showToast(THRESHOLD_TOO_LOW, 'error')
      }
    }, 600)
    return () => clearTimeout(t)
  }, [thresholdInput]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (reloadInput === '') return
    const t = setTimeout(() => {
      if (isNaN(reloadValue) || reloadValue < MIN_RELOAD_USD) {
        showToast(RELOAD_TOO_LOW, 'error')
      }
    }, 600)
    return () => clearTimeout(t)
  }, [reloadInput]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpdate = () => {
    updateMutation.mutate(
      { thresholdUsd: thresholdValue, reloadAmountUsd: reloadValue },
      {
        onSuccess: () => {
          showToast('Auto-reload settings updated.', 'success')
          onClose()
        },
        onError: (err) => {
          const reason = err instanceof ApiError && err.status === 400 ? SAVE_ERRORS[err.message] : undefined
          showToast(reason ?? 'Failed to update auto-reload settings.', 'error')
        },
      },
    )
  }

  const handleDisable = () => {
    disableMutation.mutate(undefined, {
      onSuccess: () => {
        showToast('Auto-reload disabled.', 'success')
        onClose()
      },
      onError: () => {
        showToast('Failed to disable auto-reload.', 'error')
      },
    })
  }

  return (
    <ModalOverlay onClose={onClose} disableClose={isPending} ariaLabelledBy="auto-reload-title">
      <div className="auto-reload-modal">
        <div className="modal-header">
          <h2 id="auto-reload-title" className="auto-reload-modal__title">Adjust auto-reload</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <XIcon width={16} height={16} />
          </button>
        </div>
        <p className="auto-reload-modal__description">
          Automatically add credits when your balance runs low.
        </p>

        <div className="auto-reload-modal__fields">
          <TextInput
            id="auto-reload-threshold"
            label="When balance drops to:"
            type="text"
            inputMode="decimal"
            prefix="$"
            suffix={thresholdInput === '' ? `$${MIN_THRESHOLD_USD} minimum` : undefined}
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            disabled={isPending}
          />

          <TextInput
            id="auto-reload-amount"
            label="Reload amount:"
            type="text"
            inputMode="decimal"
            prefix="$"
            suffix={reloadInput === '' ? `$${MIN_RELOAD_USD} minimum` : undefined}
            value={reloadInput}
            onChange={(e) => setReloadInput(e.target.value)}
            disabled={isPending}
          />
        </div>

        <p className="auto-reload-modal__card-note">
          {cardLast4
            ? `Credits will be charged to card ending in ${cardLast4}`
            : 'Credits will be charged to the payment method on file'}
        </p>

        <div className="auto-reload-modal__actions">
          {isEnabled ? (
            <Button variant="outline" onClick={handleDisable} disabled={isPending}>
              {disableMutation.isPending ? 'Disabling…' : 'Disable'}
            </Button>
          ) : (
            <span />
          )}
          <div className="auto-reload-modal__actions-right">
            <Button variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleUpdate} disabled={isPending || !isValid}>
              {updateMutation.isPending ? 'Saving…' : 'Update'}
            </Button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
