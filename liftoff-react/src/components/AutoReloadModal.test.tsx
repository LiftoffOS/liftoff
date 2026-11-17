import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AutoReloadModal from './AutoReloadModal'
import { ApiError } from '../services/api'

const toast = vi.hoisted(() => ({ showToast: vi.fn() }))
const update = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }))
const disable = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }))

vi.mock('../contexts/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../hooks/useBilling', () => ({
  useUpdateAutoReload: () => update,
  useDisableAutoReload: () => disable,
}))

function renderModal(currentSettings: { enabled: boolean; thresholdUsd: number; reloadAmountUsd: number } | null = null) {
  render(<AutoReloadModal cardLast4="4242" currentSettings={currentSettings} onClose={vi.fn()} />)
}

function fill(threshold: string, amount: string) {
  fireEvent.change(screen.getByLabelText('When balance drops to:'), { target: { value: threshold } })
  fireEvent.change(screen.getByLabelText('Reload amount:'), { target: { value: amount } })
}

beforeEach(() => vi.clearAllMocks())

describe('AutoReloadModal', () => {
  it('names the second field for what it charges, and shows both minimums', () => {
    renderModal()
    expect(screen.getByLabelText('Reload amount:')).toBeTruthy()
    expect(screen.queryByText('Restore balance to:')).toBeNull()
    expect(screen.getByText('$1 minimum')).toBeTruthy()
    expect(screen.getByText('$5 minimum')).toBeTruthy()
  })

  it('saves a $1 threshold with a $5 reload', () => {
    renderModal()
    fill('1', '5')
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(update.mutate).toHaveBeenCalledWith({ thresholdUsd: 1, reloadAmountUsd: 5 }, expect.anything())
  })

  it('will not save a threshold under $1 or a reload under $5', () => {
    renderModal()
    fill('0.5', '5')
    expect((screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(true)
    fill('1', '4.99')
    expect((screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says which minimum a refused save missed', () => {
    renderModal()
    fill('1', '5')
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    const { onError } = update.mutate.mock.calls[0][1]
    onError(new ApiError('thresholdUsd_must_be_at_least_1', 400))
    expect(toast.showToast).toHaveBeenLastCalledWith('Balance threshold must be at least $1.', 'error')
    onError(new ApiError('HTTP 500', 500))
    expect(toast.showToast).toHaveBeenLastCalledWith('Failed to update auto-reload settings.', 'error')
  })

  it('opens on the saved settings, with Disable when auto-reload is on', () => {
    renderModal({ enabled: true, thresholdUsd: 1, reloadAmountUsd: 25 })
    expect((screen.getByLabelText('When balance drops to:') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('Reload amount:') as HTMLInputElement).value).toBe('25')
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
  })
})
