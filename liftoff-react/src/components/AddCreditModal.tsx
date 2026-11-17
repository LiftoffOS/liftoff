import { useState, useEffect } from 'react'
import XIcon from '../assets/icons/x.svg?react'
import ModalOverlay from './ModalOverlay'
import Button from './Button'
import { TextInput } from '.'
import PaymentUpdateModal from './PaymentUpdateModal'
import { useToast } from '../contexts/ToastContext'
import { usePurchaseCredits } from '../hooks/useBilling'
import './AddCreditModal.css'

type Preset = 50 | 250 | 1000 | 'other'

const PRESETS: { value: Preset; label: string }[] = [
  { value: 50, label: '$50' },
  { value: 250, label: '$250' },
  { value: 1000, label: '$1,000' },
  { value: 'other', label: 'Other' },
]

interface AddCreditModalProps {
  tenantId: string
  paymentMethod: { brand: string; last4: string } | null
  onClose: () => void
}

export default function AddCreditModal({ tenantId, paymentMethod, onClose }: AddCreditModalProps) {
  const { showToast } = useToast()
  const purchaseMutation = usePurchaseCredits()

  const [selectedPreset, setSelectedPreset] = useState<Preset>(50)
  const [customInput, setCustomInput] = useState('')
  const [showEditPayment, setShowEditPayment] = useState(false)

  const customValue = parseFloat(customInput)

  useEffect(() => {
    if (selectedPreset !== 'other' || customInput === '') return
    const t = setTimeout(() => {
      if (isNaN(customValue) || customValue < 5) {
        showToast('Amount must be at least $5.', 'error')
      }
    }, 600)
    return () => clearTimeout(t)
  }, [customInput]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedAmount: number | null =
    selectedPreset === 'other'
      ? customInput !== '' && !isNaN(customValue) && customValue >= 5 ? customValue : null
      : selectedPreset

  const canBuy = selectedAmount !== null && paymentMethod !== null && !purchaseMutation.isPending

  const handleBuy = () => {
    if (!canBuy || selectedAmount === null) return
    purchaseMutation.mutate(selectedAmount, {
      onSuccess: () => {
        showToast(`$${selectedAmount.toLocaleString()} added to your credit balance.`, 'success')
        onClose()
      },
      onError: (err) => {
        // The issuer's own words where there are any: a decline and a failed
        // authentication are different problems, and "please try again" is
        // wrong advice for both. The generic line is the fallback for a
        // failure that carries no message of its own.
        showToast(
          err instanceof Error && err.message
            ? err.message
            : 'Failed to add credits. Please try again.',
          'error',
        )
      },
    })
  }

  const formattedAmount = selectedAmount != null
    ? `$${selectedAmount % 1 === 0 ? selectedAmount.toLocaleString() : selectedAmount.toFixed(2)}`
    : null

  const brandLabel = paymentMethod
    ? paymentMethod.brand.charAt(0).toUpperCase() + paymentMethod.brand.slice(1)
    : null

  return (
    <>
      <ModalOverlay onClose={onClose} disableClose={purchaseMutation.isPending} ariaLabelledBy="add-credit-title">
        <div className="add-credit-modal">
          <div className="modal-header">
            <h2 id="add-credit-title" className="add-credit-modal__title">Add to Credit Balance</h2>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close" disabled={purchaseMutation.isPending}>
              <XIcon width={16} height={16} />
            </button>
          </div>
          <p className="add-credit-modal__description">
            Choose an amount to start. You can always buy more later.
          </p>

          <div className="add-credit-modal__presets">
            {PRESETS.map(({ value, label }) => (
              <button
                key={String(value)}
                type="button"
                className={`add-credit-modal__preset${selectedPreset === value ? ' add-credit-modal__preset--selected' : ''}`}
                onClick={() => setSelectedPreset(value)}
                disabled={purchaseMutation.isPending}
              >
                {label}
              </button>
            ))}
          </div>

          {selectedPreset === 'other' && (
            <div className="add-credit-modal__custom">
              <TextInput
                id="add-credit-custom"
                type="text"
                inputMode="decimal"
                prefix="$"
                suffix={customInput === '' ? '$5 minimum' : undefined}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                disabled={purchaseMutation.isPending}
              />
            </div>
          )}

          <div className="add-credit-modal__payment">
            <span className="add-credit-modal__payment-label">Payment method</span>
            <div className="add-credit-modal__payment-row">
              {paymentMethod ? (
                <>
                  <span className="add-credit-modal__payment-value">
                    {brandLabel} ···· {paymentMethod.last4}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setShowEditPayment(true)} disabled={purchaseMutation.isPending}>
                    Edit
                  </Button>
                </>
              ) : (
                <>
                  <span className="add-credit-modal__payment-none">No card on file</span>
                  <Button variant="outline" size="sm" onClick={() => setShowEditPayment(true)}>
                    Add
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="add-credit-modal__cta">
            <Button variant="primary" className="add-credit-modal__buy-btn" onClick={handleBuy} disabled={!canBuy}>
              {purchaseMutation.isPending ? 'Processing…' : formattedAmount ? `Buy ${formattedAmount} Now` : 'Buy Now'}
            </Button>
            <p className="add-credit-modal__legal">
              By clicking Buy Now, you allow Liftoff to charge your card in the amount above.
              Credits are non-refundable and do not expire while your account is open.
            </p>
          </div>
        </div>
      </ModalOverlay>

      {showEditPayment && (
        <PaymentUpdateModal
          tenantId={tenantId}
          onClose={() => setShowEditPayment(false)}
        />
      )}
    </>
  )
}
