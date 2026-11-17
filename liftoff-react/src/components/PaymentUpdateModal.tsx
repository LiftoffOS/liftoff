import ModalOverlay from './ModalOverlay'
import PaymentFormPanel from './PaymentForm'

interface PaymentUpdateModalProps {
  tenantId: string
  title?: string
  subtitle?: string
  submitLabel?: string
  /**
   * When true, after the new card is saved as the customer's default, the form
   * immediately calls POST /retry-outstanding-charge and polls current-usage
   * until executionBlocked flips to false (or a decline is detected). Use this
   * when the user is opening the modal specifically to resolve a suspended
   * workspace. Leave undefined/false for normal "update card" / "subscribe" /
   * "add credit" flows that handle their own charges.
   */
  chargeOutstandingOnSave?: boolean
  onAfterSave?: () => Promise<void>
  onClose: () => void
  onSuccess?: () => void
}

export default function PaymentUpdateModal({
  tenantId,
  title,
  subtitle,
  submitLabel,
  chargeOutstandingOnSave,
  onAfterSave,
  onClose,
  onSuccess,
}: PaymentUpdateModalProps) {
  return (
    <ModalOverlay onClose={onClose} disableClose={false} ariaLabelledBy="payment-modal-title">
      <PaymentFormPanel
        tenantId={tenantId}
        title={title}
        subtitle={subtitle}
        submitLabel={submitLabel}
        chargeOutstandingOnSave={chargeOutstandingOnSave}
        onAfterSave={onAfterSave}
        onSuccess={onSuccess}
        onClose={onClose}
      />
    </ModalOverlay>
  )
}
