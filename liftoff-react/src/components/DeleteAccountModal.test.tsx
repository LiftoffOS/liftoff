import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DeleteAccountModal from './DeleteAccountModal'
import { chooseShape, composeBody } from './deleteAccountCopy'
import type { DeletionPreflight } from '../services/account'

const mockNavigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
})

const mockSignOut = vi.fn().mockResolvedValue(undefined)
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}))

const mockShowToast = vi.fn()
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

const mockDeleteSelf = vi.fn().mockResolvedValue(undefined)
vi.mock('../hooks/useAccount', () => ({
  useDeleteSelf: () => ({ mutateAsync: mockDeleteSelf }),
}))

function renderModal(preflight: DeletionPreflight, onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<DeleteAccountModal open={true} onClose={onClose} preflight={preflight} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onClose }
}

const BASE: DeletionPreflight = {
  hasActiveSubscription: false,
  hasOutstandingInvoice: false,
  orphanWorkspaceCount: 0,
  lostAccessCount: 0,
  memberOfWorkspaceCount: 0,
}

beforeEach(() => {
  mockNavigate.mockReset()
  mockSignOut.mockClear()
  mockDeleteSelf.mockReset().mockResolvedValue(undefined)
  mockShowToast.mockReset()
})

describe('chooseShape', () => {
  it('hasActiveSubscription=true → block_sub', () => {
    expect(chooseShape({ ...BASE, hasActiveSubscription: true })).toBe('block_sub')
  })
  it('hasOutstandingInvoice=true → block_invoice', () => {
    expect(chooseShape({ ...BASE, hasOutstandingInvoice: true })).toBe('block_invoice')
  })
  it('no blocks → confirm_delete', () => {
    expect(chooseShape(BASE)).toBe('confirm_delete')
  })
})

describe('composeBody (confirm_delete shape)', () => {
  it('X=0 P=0 Y=0 renders fixed closer only', () => {
    expect(composeBody('confirm_delete', { ...BASE })).toBe(
      'Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
  it('X=0 P=0 Y=1 renders "You will be removed from the workspace you belong to."', () => {
    expect(composeBody('confirm_delete', { ...BASE, memberOfWorkspaceCount: 1 })).toBe(
      'You will be removed from the workspace you belong to. Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
  it('X=0 P=0 Y=3 renders plural members-of copy', () => {
    expect(composeBody('confirm_delete', { ...BASE, memberOfWorkspaceCount: 3 })).toBe(
      'You will be removed from 3 workspaces you belong to. Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
  it('X=1 P=1 Y=0 renders singular lose-access copy', () => {
    expect(composeBody('confirm_delete', { ...BASE, orphanWorkspaceCount: 1, lostAccessCount: 1 })).toBe(
      '1 person will lose access to your workspace. Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
  it('X=1 P=5 Y=0 renders plural-people single-workspace copy', () => {
    expect(composeBody('confirm_delete', { ...BASE, orphanWorkspaceCount: 1, lostAccessCount: 5 })).toBe(
      '5 people will lose access to your workspace. Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
  it('X=2 P=8 Y=0 renders plural-workspaces copy', () => {
    expect(composeBody('confirm_delete', { ...BASE, orphanWorkspaceCount: 2, lostAccessCount: 8 })).toBe(
      '8 people will lose access to 2 of your workspaces. Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
  it('X=1 P=5 Y=2 renders both sentences with "also" qualifier and "other" in Sentence 2', () => {
    expect(composeBody('confirm_delete', { ...BASE, orphanWorkspaceCount: 1, lostAccessCount: 5, memberOfWorkspaceCount: 2 })).toBe(
      '5 people will lose access to your workspace. You will also be removed from 2 other workspaces you belong to. Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
  it('X=1 P=1 Y=1 renders both sentences with singular forms', () => {
    expect(composeBody('confirm_delete', { ...BASE, orphanWorkspaceCount: 1, lostAccessCount: 1, memberOfWorkspaceCount: 1 })).toBe(
      '1 person will lose access to your workspace. You will also be removed from another workspace you belong to. Are you sure you want to delete your account? This action cannot be undone.',
    )
  })
})

describe('DeleteAccountModal interactions', () => {
  it('block_sub shape — clicking Billing navigates to billing and does not call deleteSelf', () => {
    const onClose = vi.fn()
    renderModal({ ...BASE, hasActiveSubscription: true }, onClose)
    fireEvent.click(screen.getByRole('button', { name: 'Billing' }))
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/settings/billing')
    expect(mockDeleteSelf).not.toHaveBeenCalled()
  })

  it('block_invoice shape — clicking Billing navigates to billing', () => {
    renderModal({ ...BASE, hasOutstandingInvoice: true })
    fireEvent.click(screen.getByRole('button', { name: 'Billing' }))
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/settings/billing')
  })

  it('confirm_delete shape — clicking Delete Account calls deleteSelf, signOut, navigates to /account-deleted', async () => {
    renderModal(BASE)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    await waitFor(() => expect(mockDeleteSelf).toHaveBeenCalled())
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled())
    expect(mockNavigate).toHaveBeenCalledWith('/account-deleted', { replace: true })
  })

  it('Cancel button closes the modal', () => {
    const onClose = vi.fn()
    renderModal(BASE, onClose)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('failed deletion surfaces a toast and the user stays', async () => {
    mockDeleteSelf.mockRejectedValueOnce(new Error('500'))
    renderModal(BASE)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      'Could not delete account. Please try again.', 'error',
    ))
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
