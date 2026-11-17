import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { useDeleteSelf } from '../hooks/useAccount'
import { track } from '../lib/analytics'
import type { DeletionPreflight } from '../services/account'
import Button from './Button'
import ModalOverlay from './ModalOverlay'
import ModalActions from './ModalActions/ModalActions'
import './DeleteAccountModal.css'
import { chooseShape, composeBody } from './deleteAccountCopy'

export interface DeleteAccountModalProps {
  open: boolean
  onClose: () => void
  preflight: DeletionPreflight
}

export default function DeleteAccountModal({ open, onClose, preflight }: DeleteAccountModalProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { signOut } = useAuth()
  const { showToast } = useToast()
  const deleteSelfMutation = useDeleteSelf()
  const [processing, setProcessing] = useState(false)
  if (!open) return null

  const shape = chooseShape(preflight)
  const body = composeBody(shape, preflight)

  async function confirmDelete(): Promise<void> {
    try {
      setProcessing(true)
      // Backend (cascadeDelete soft-scrub) calls getAuth().revokeRefreshTokens
      // on the way through, so any open tabs / devices get kicked on their
      // next API call. This client-side signOut clears the current tab's
      // Firebase state immediately.
      await deleteSelfMutation.mutateAsync()
      track('settings_account_delete_confirmed', {})
      await signOut()
      queryClient.clear()
      localStorage.clear()
      sessionStorage.clear()
      navigate('/account-deleted', { replace: true })
    } catch {
      setProcessing(false)
      showToast('Could not delete account. Please try again.', 'error')
    }
  }

  function navigateToBilling(): void {
    onClose()
    navigate('/dashboard/settings/billing')
  }

  return (
    <ModalOverlay onClose={onClose} ariaLabelledBy="delete-account-title" disableClose={processing}>
      <div className="delete-account-modal">
        <div className="modal-header">
          <h2 id="delete-account-title">Delete Account</h2>
        </div>
        <p>{body}</p>
        <ModalActions>
          <Button variant="outline" onClick={onClose} disabled={processing}>Cancel</Button>
          {shape === 'block_sub' || shape === 'block_invoice' ? (
            <Button variant="primary" onClick={navigateToBilling}>Billing</Button>
          ) : (
            <Button variant="destructive" onClick={confirmDelete} disabled={processing}>
              {processing ? 'Deleting…' : 'Delete Account'}
            </Button>
          )}
        </ModalActions>
      </div>
    </ModalOverlay>
  )
}
