// Tests for the Manage Files flow on /dashboard/knowledge.
//
// The page is the half of the fix the picker cannot do on its own: it seeds the
// picker from the library, and it turns the picker's removal list (connector
// file ids) back into knowledge item ids for the delete endpoint. Those two id
// spaces look alike and mapping the wrong one deletes nothing.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BrowseResult } from '../../services/knowledge'

// Capture the picker's props instead of rendering the browse tree.
const filePickerProps: Array<Record<string, unknown>> = []
vi.mock('../../components/FilePicker/FilePicker', () => ({
  default: (props: Record<string, unknown>) => {
    filePickerProps.push(props)
    return <div data-testid="file-picker" />
  },
}))

const getPinningTeams = vi.fn()
vi.mock('../../services/knowledge', () => ({
  getPinningTeams: (...args: unknown[]) => getPinningTeams(...args),
}))
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))
vi.mock('../../hooks/useIntegrations', () => ({ useIntegrations: vi.fn() }))
vi.mock('../../hooks/useKnowledge', () => ({
  useKnowledgeItems: vi.fn(),
  useBatchCreateKnowledgeItems: vi.fn(),
  useDeleteKnowledgeItem: vi.fn(),
  useSyncItems: vi.fn(),
}))
const showToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

import KnowledgePage from './KnowledgePage'
import { useIntegrations } from '../../hooks/useIntegrations'
import {
  useKnowledgeItems,
  useBatchCreateKnowledgeItems,
  useDeleteKnowledgeItem,
  useSyncItems,
} from '../../hooks/useKnowledge'

const CONNECTOR_ID = 'cc11d4b7-0000-4000-8000-000000000001'

const connectedDrive = {
  id: CONNECTOR_ID,
  name: 'Google Drive',
  type: 'Documents',
  icon: null,
  status: 'connected' as const,
  objectsCovered: [],
  connectorType: 'google_drive' as const,
  connector: { id: CONNECTOR_ID },
}

// Already in the library: `externalId` is the connector's file id, `id` is the
// knowledge item's own uuid. The delete endpoint takes the latter.
const existingItem = {
  id: 'kb-item-uuid-1',
  externalId: 'file-report',
  title: 'Q3 report',
  connectorId: CONNECTOR_ID,
  connectorType: 'google_drive',
  contentType: 'document',
}

const batchCreateMutate = vi.fn()
const deleteMutate = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  filePickerProps.length = 0
  batchCreateMutate.mockResolvedValue({ created: [] })
  deleteMutate.mockResolvedValue(undefined)
  getPinningTeams.mockResolvedValue([])

  vi.mocked(useIntegrations).mockReturnValue({
    integrations: [],
    connected: [connectedDrive],
    available: [],
    planned: [],
    isPending: false,
  } as unknown as ReturnType<typeof useIntegrations>)
  vi.mocked(useKnowledgeItems).mockReturnValue({
    data: [existingItem],
  } as unknown as ReturnType<typeof useKnowledgeItems>)
  vi.mocked(useBatchCreateKnowledgeItems).mockReturnValue({
    mutateAsync: batchCreateMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useBatchCreateKnowledgeItems>)
  vi.mocked(useDeleteKnowledgeItem).mockReturnValue({
    mutateAsync: deleteMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useDeleteKnowledgeItem>)
  vi.mocked(useSyncItems).mockReturnValue({
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useSyncItems>)
})

const openPicker = () => {
  render(<KnowledgePage />)
  fireEvent.click(screen.getByRole('button', { name: /manage files/i }))
  return filePickerProps[filePickerProps.length - 1]
}

describe('KnowledgePage — Manage Files', () => {
  it('seeds the picker with the connector file ids already in the library', () => {
    const props = openPicker()
    expect(props.alreadySelectedIds).toEqual(['file-report'])
  })

  it('deletes by knowledge item id when the picker reports a removed connector file id', async () => {
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [],
      ['file-report'],
    )

    // 'file-report' is the connector's id; 'kb-item-uuid-1' is ours.
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('kb-item-uuid-1'))
    expect(batchCreateMutate).not.toHaveBeenCalled()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Removed 1 item', 'success'))
  })

  it('ignores a removed id that matches no library item rather than deleting the wrong row', async () => {
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [],
      ['file-that-is-not-here'],
    )

    expect(deleteMutate).not.toHaveBeenCalled()
  })

  it('adds and removes in one confirm, and says so', async () => {
    batchCreateMutate.mockResolvedValue({ created: [{ id: 'kb-item-uuid-2' }] })
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [{ id: 'file-notes', title: 'Meeting notes', contentType: 'document' } as BrowseResult],
      ['file-report'],
    )

    await waitFor(() =>
      expect(batchCreateMutate).toHaveBeenCalledWith([
        expect.objectContaining({ externalId: 'file-notes', connectorId: CONNECTOR_ID }),
      ]),
    )
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('kb-item-uuid-1'))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Added 1 item and removed 1 item', 'success'),
    )
  })

  it('holds the removal and names the teams when a file is pinned', async () => {
    getPinningTeams.mockResolvedValue([{ id: 'team-1', role: 'Sales Development Rep' }])
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [],
      ['file-report'],
    )

    await screen.findByText('This file is in use')
    expect(screen.getByText('Pinned by Sales Development Rep')).toBeInTheDocument()
    // Nothing has been touched yet — the warning is a question, not a receipt.
    expect(deleteMutate).not.toHaveBeenCalled()
  })

  it('keeps the file when the warning is declined', async () => {
    getPinningTeams.mockResolvedValue([{ id: 'team-1', role: 'Sales Development Rep' }])
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [],
      ['file-report'],
    )
    fireEvent.click(await screen.findByRole('button', { name: /keep files/i }))

    expect(deleteMutate).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('This file is in use')).toBeNull())
  })

  it('removes it after the warning is accepted', async () => {
    getPinningTeams.mockResolvedValue([{ id: 'team-1', role: 'Sales Development Rep' }])
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [],
      ['file-report'],
    )
    fireEvent.click(await screen.findByRole('button', { name: /remove anyway/i }))

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('kb-item-uuid-1'))
  })

  it('removes without a warning when nothing pins the file', async () => {
    getPinningTeams.mockResolvedValue([])
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [],
      ['file-report'],
    )

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('kb-item-uuid-1'))
    expect(screen.queryByText('This file is in use')).toBeNull()
  })

  it('does not block the removal when the pin lookup fails', async () => {
    // A warning that cannot load is not a reason to refuse the user's action.
    getPinningTeams.mockRejectedValue(new Error('network'))
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [],
      ['file-report'],
    )

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('kb-item-uuid-1'))
  })

  it('reports what got through when a delete fails midway', async () => {
    batchCreateMutate.mockResolvedValue({ created: [{ id: 'kb-item-uuid-2' }] })
    deleteMutate.mockRejectedValue(new Error('network'))
    const props = openPicker()

    await (props.onSelect as (r: BrowseResult[], removed: string[]) => Promise<void>)(
      [{ id: 'file-notes', title: 'Meeting notes', contentType: 'document' } as BrowseResult],
      ['file-report'],
    )

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Added 1 item'),
        'error',
      ),
    )
  })
})
