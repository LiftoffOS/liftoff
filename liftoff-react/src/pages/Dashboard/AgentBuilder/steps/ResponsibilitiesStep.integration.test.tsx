// Integration test for the team-build import flow — real ResponsibilitiesStep,
// ResponsibilitiesInput, FileUploadPopover, FilePicker, and
// ConnectIntegrationModal running against the MSW mock backend (the same
// handlers dev:mock serves). Only the TipTap editor (jsdom-incompatible) and
// the auth/toast contexts are mocked.
//
// Covers the three user-visible behaviors of the attachments change:
//   1. Desktop upload never touches the editor value; it produces a card and
//      enables Continue.
//   2. A connected cloud provider (Google Drive in the mock data) opens the
//      shared file picker, and a selection becomes a connector attachment.
//   3. An unconnected provider (Dropbox in the mock data) opens the connect
//      modal.

import { useState } from 'react'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '../../../../test/utils'
import type { TeamAttachment } from '../../../../services/internalAgents'

// TipTap does not run under jsdom; capture props so we can assert the editor
// value is never written by imports.
const editorProps: Array<Record<string, unknown>> = []
vi.mock('../../../../components/MarkdownTextarea', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.push(props)
    return null
  },
}))
vi.mock('../../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'user-1', emailVerified: true },
    currentTenant: { id: 'tenant-1' },
    tenantLoading: false,
    loading: false,
    backendConnected: true,
    getIdToken: vi.fn().mockResolvedValue('test-token'),
    refreshTenants: vi.fn(),
  }),
}))
vi.mock('../../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

import ResponsibilitiesStep from './ResponsibilitiesStep'

function Harness({ onContinue }: { onContinue: () => void }) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<TeamAttachment[]>([])
  return (
    <ResponsibilitiesStep
      value={value}
      onChange={setValue}
      onContinue={onContinue}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
    />
  )
}

async function openPopover(queryClient: import('@tanstack/react-query').QueryClient) {
  // The provider branch reads the connectors + catalog queries; wait for both
  // so a click deterministically sees the mock backend's state.
  await waitFor(() => {
    expect(queryClient.getQueryState(['connectors', 'tenant-1'])?.status).toBe('success')
    expect(queryClient.getQueryState(['connector-catalog'])?.status).toBe('success')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Import document' }))
}

describe('team-build import flow (integration, MSW backend)', () => {
  beforeEach(() => {
    editorProps.length = 0
  })

  it('desktop upload: no editor write, card renders, Continue enables', async () => {
    const onContinue = vi.fn()
    const { container } = render(<Harness onContinue={onContinue} />)

    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Import document' }))
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['# Skills'], 'skills.md', { type: 'text/markdown' })] },
    })

    expect(await screen.findByText('skills.md')).toBeInTheDocument()
    // The editor value was never written to — imports do not paste text.
    expect(editorProps[editorProps.length - 1].value).toBe('')
    expect(continueButton).not.toBeDisabled()
    fireEvent.click(continueButton)
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('connected provider: opens the file picker and attaches the selection', async () => {
    const { queryClient } = render(<Harness onContinue={() => {}} />)

    await openPopover(queryClient)
    fireEvent.click(screen.getByRole('button', { name: 'Google Drive' }))

    // Real FilePicker in a ModalOverlay, fed by GET /api/knowledge/browse.
    expect(await screen.findByText('Select files from Google Drive')).toBeInTheDocument()
    expect(await screen.findByText('Engineering Roadmap 2026')).toBeInTheDocument()
    expect(screen.getByText('Q1 Reports')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Engineering Roadmap 2026'))
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1 item' }))

    // The selection became a connector attachment card under the input.
    await waitFor(() => {
      expect(screen.queryByText('Select files from Google Drive')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Engineering Roadmap 2026')).toBeInTheDocument()
    expect(editorProps[editorProps.length - 1].value).toBe('')
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })

  it('unconnected provider: opens the connect modal', async () => {
    const { queryClient } = render(<Harness onContinue={() => {}} />)

    await openPopover(queryClient)
    fireEvent.click(screen.getByRole('button', { name: 'Dropbox' }))

    expect(await screen.findByRole('heading', { name: 'Connect Dropbox' })).toBeInTheDocument()
  })
})
