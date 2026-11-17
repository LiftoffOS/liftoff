// Tests for FileUploadPopover — desktop uploads emit a single upload
// attachment via onAttach (file text never goes anywhere else), and the
// cloud provider buttons branch: connected provider opens the file picker,
// unconnected provider opens the connect modal.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture props instead of rendering the heavy real modals.
const connectModalProps: Array<Record<string, unknown>> = []
vi.mock('../ConnectIntegrationModal', () => ({
  default: (props: Record<string, unknown>) => {
    connectModalProps.push(props)
    return null
  },
}))
const filePickerProps: Array<Record<string, unknown>> = []
vi.mock('../FilePicker/FilePicker', () => ({
  default: (props: Record<string, unknown>) => {
    filePickerProps.push(props)
    return null
  },
}))
vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: vi.fn(),
}))

import FileUploadPopover from './FileUploadPopover'
import { useIntegrations } from '../../hooks/useIntegrations'

const catalogDrive = {
  id: 'google_drive',
  name: 'Google Drive',
  type: 'Documents',
  icon: null,
  status: 'available' as const,
  objectsCovered: [],
  connectorType: 'google_drive' as const,
  connector: undefined,
}

const connectedDrive = {
  id: 'conn-1',
  name: 'Google Drive',
  type: 'Documents',
  icon: null,
  status: 'connected' as const,
  objectsCovered: [],
  connectorType: 'google_drive' as const,
  connector: { id: 'conn-1' } as never,
}

const mockIntegrations = (connected: unknown[]) => {
  vi.mocked(useIntegrations).mockReturnValue({
    integrations: [catalogDrive],
    connected,
    available: [catalogDrive],
    planned: [],
    isPending: false,
  } as unknown as ReturnType<typeof useIntegrations>)
}

describe('FileUploadPopover', () => {
  beforeEach(() => {
    connectModalProps.length = 0
    filePickerProps.length = 0
    mockIntegrations([])
  })

  it('emits a single upload attachment for a desktop file and closes', async () => {
    const onAttach = vi.fn()
    const onClose = vi.fn()
    const { container } = render(
      <FileUploadPopover isOpen onClose={onClose} onAttach={onAttach} />,
    )

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['# Skills'], 'skills.md', { type: 'text/markdown' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1))
    const [attachments] = onAttach.mock.calls[0]
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      kind: 'upload',
      name: 'skills.md',
      content: '# Skills',
    })
    expect(typeof attachments[0].addedAt).toBe('string')
    expect(onClose).toHaveBeenCalled()
  })

  it('opens the connect modal when the provider is not connected', () => {
    const onClose = vi.fn()
    render(<FileUploadPopover isOpen onClose={onClose} onAttach={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Google Drive' }))

    expect(connectModalProps).toHaveLength(1)
    expect(connectModalProps[0].integration).toBe(catalogDrive)
    expect(filePickerProps).toHaveLength(0)
    expect(onClose).toHaveBeenCalled()
  })

  it('opens the file picker when the provider is connected, and maps selections to connector attachments', async () => {
    mockIntegrations([connectedDrive])
    const onAttach = vi.fn()
    const onClose = vi.fn()
    render(<FileUploadPopover isOpen onClose={onClose} onAttach={onAttach} />)

    fireEvent.click(screen.getByRole('button', { name: 'Google Drive' }))

    expect(connectModalProps).toHaveLength(0)
    expect(filePickerProps.length).toBeGreaterThan(0)
    expect(filePickerProps[0].connectorId).toBe('conn-1')
    expect(filePickerProps[0].actionVerb).toBe('Attach')
    expect(onClose).toHaveBeenCalled()

    const onSelect = filePickerProps[0].onSelect as (results: Record<string, unknown>[]) => void
    act(() => {
      onSelect([
        {
          id: 'file-9',
          title: 'playbook.md',
          url: 'https://drive.example/file-9',
          contentType: 'document',
          excerpt: null,
          metadata: {},
        },
      ])
    })

    expect(onAttach).toHaveBeenCalledTimes(1)
    const [attachments] = onAttach.mock.calls[0]
    expect(attachments).toEqual([
      expect.objectContaining({
        kind: 'connector',
        name: 'playbook.md',
        connectorId: 'conn-1',
        connectorType: 'google_drive',
        externalId: 'file-9',
        sourceUrl: 'https://drive.example/file-9',
      }),
    ])
  })
})
