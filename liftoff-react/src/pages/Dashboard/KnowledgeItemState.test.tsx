// A knowledge item that holds no text must not look like a working one.
//
// The card labelled itself from `syncStatus` alone, which only says whether
// the row arrived. Extraction — whether anything can actually read the file —
// was never rendered. So a file that failed extraction showed "Synced 2
// minutes ago" and read as finished, in a library where its content is the
// entire point. Two dev files sat in that state while the underlying fetch
// was returning 401 on every attempt.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const filePickerProps: Array<Record<string, unknown>> = []
vi.mock('../../components/FilePicker/FilePicker', () => ({
  default: (props: Record<string, unknown>) => {
    filePickerProps.push(props)
    return <div data-testid="file-picker" />
  },
}))
vi.mock('../../services/knowledge', () => ({ getPinningTeams: vi.fn() }))
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
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
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

const baseItem = {
  id: 'kb-1',
  externalId: 'file-1',
  title: 'Q3 report',
  connectorId: CONNECTOR_ID,
  connectorType: 'google_drive',
  contentType: 'document',
  syncStatus: 'synced',
  lastSyncedAt: new Date().toISOString(),
  syncError: null,
  extractionStatus: 'done',
}

const renderWithItem = (overrides: Record<string, unknown>) => {
  vi.mocked(useKnowledgeItems).mockReturnValue({
    data: [{ ...baseItem, ...overrides }],
  } as unknown as ReturnType<typeof useKnowledgeItems>)
  render(<KnowledgePage />)
  // Items live inside a per-connector group that starts collapsed.
  fireEvent.click(screen.getByRole('button', { name: /1 file/i }))
}

beforeEach(() => {
  vi.clearAllMocks()
  filePickerProps.length = 0
  vi.mocked(useIntegrations).mockReturnValue({
    integrations: [],
    connected: [connectedDrive],
    available: [],
    planned: [],
    isPending: false,
  } as unknown as ReturnType<typeof useIntegrations>)
  vi.mocked(useBatchCreateKnowledgeItems).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useBatchCreateKnowledgeItems>)
  vi.mocked(useDeleteKnowledgeItem).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useDeleteKnowledgeItem>)
  vi.mocked(useSyncItems).mockReturnValue({
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useSyncItems>)
})

describe('knowledge item state', () => {
  it('says the file could not be read when extraction failed', () => {
    renderWithItem({
      extractionStatus: 'error',
      syncError: 'No readable text found in this file (application/pdf).',
    })

    expect(screen.getByText('No text could be read')).toBeInTheDocument()
    // The row synced fine, but that is not the useful truth about it.
    expect(screen.queryByText(/^Synced /)).toBeNull()
  })

  it('shows progress while the file is still being read', () => {
    renderWithItem({ extractionStatus: 'pending' })
    expect(screen.getByText('Reading…')).toBeInTheDocument()
  })

  it('shows the sync time once the text is in', () => {
    renderWithItem({ extractionStatus: 'done' })
    expect(screen.getByText(/^Synced /)).toBeInTheDocument()
  })

  it('leaves folders alone — they carry no text by design', () => {
    renderWithItem({ contentType: 'folder', extractionStatus: 'none' })
    expect(screen.getByText(/^Synced /)).toBeInTheDocument()
    expect(screen.queryByText('No text could be read')).toBeNull()
  })
})

describe('a file we could only read part of', () => {
  it('says so instead of reporting a clean sync', () => {
    renderWithItem({ extractionStatus: 'done', metadata: { extractionTruncated: true } })

    expect(screen.getByText('Partially read')).toBeInTheDocument()
    expect(screen.queryByText(/^Synced /)).toBeNull()
  })

  it('reports a clean sync when the whole file fit', () => {
    renderWithItem({ extractionStatus: 'done', metadata: { extractionTruncated: false } })

    expect(screen.getByText(/^Synced /)).toBeInTheDocument()
    expect(screen.queryByText('Partially read')).toBeNull()
  })
})
