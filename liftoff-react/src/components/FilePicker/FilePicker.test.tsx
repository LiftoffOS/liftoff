// Tests for FilePicker's management behaviour: it opens with the caller's
// existing selection already checked, and confirming reports both what was
// added and what was unchecked.
//
// The bug these pin: the picker used to start blank no matter what the caller
// already held, so the "Manage Files" modal on /dashboard/knowledge showed a
// full directory with nothing ticked. Nothing looked selected, so nothing
// could be unselected, and there was no way to take a file back out of the
// library from anywhere in the app.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BrowseResult } from '../../services/knowledge'

const mockUseBrowseConnector = vi.fn()
vi.mock('../../hooks/useKnowledge', () => ({
  useBrowseConnector: (...args: unknown[]) => mockUseBrowseConnector(...args),
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

import FilePicker from './FilePicker'

const file = (id: string, title: string): BrowseResult =>
  ({ id, title, contentType: 'document' }) as BrowseResult

const REPORT = file('file-report', 'Q3 report')
const NOTES = file('file-notes', 'Meeting notes')

beforeEach(() => {
  vi.clearAllMocks()
  mockUseBrowseConnector.mockReturnValue({
    data: { pages: [{ results: [REPORT, NOTES] }] },
    isPending: false,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  })
})

const checkboxFor = (title: string): HTMLInputElement => {
  const row = screen.getByText(title).closest('label')
  if (!row) throw new Error(`no row for ${title}`)
  const box = row.querySelector('input[type="checkbox"]')
  if (!box) throw new Error(`no checkbox for ${title}`)
  return box as HTMLInputElement
}

describe('FilePicker — already-selected rows', () => {
  it('renders rows named by alreadySelectedIds as checked', () => {
    render(
      <FilePicker
        connectorId="conn-1"
        alreadySelectedIds={[REPORT.id]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    expect(checkboxFor('Q3 report').checked).toBe(true)
    expect(checkboxFor('Meeting notes').checked).toBe(false)
  })

  it('reports an unchecked pre-existing row as a removal, and does not re-send it as an add', () => {
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        alreadySelectedIds={[REPORT.id]}
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    fireEvent.click(checkboxFor('Q3 report'))
    fireEvent.click(screen.getByRole('button', { name: /remove 1 item/i }))

    expect(onSelect).toHaveBeenCalledWith([], [REPORT.id])
  })

  it('leaves an untouched pre-existing row out of both lists', () => {
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        alreadySelectedIds={[REPORT.id]}
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    // Add one, leave the existing one alone. The existing row is already in the
    // caller's collection, so re-sending it would be a pointless write.
    fireEvent.click(checkboxFor('Meeting notes'))
    fireEvent.click(screen.getByRole('button', { name: /add 1 item/i }))

    expect(onSelect).toHaveBeenCalledWith([NOTES], [])
  })

  it('confirms an add and a removal together in one press', () => {
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        alreadySelectedIds={[REPORT.id]}
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    fireEvent.click(checkboxFor('Q3 report'))
    fireEvent.click(checkboxFor('Meeting notes'))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(onSelect).toHaveBeenCalledWith([NOTES], [REPORT.id])
  })

  it('disables confirm until something actually changes', () => {
    render(
      <FilePicker
        connectorId="conn-1"
        alreadySelectedIds={[REPORT.id]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    // One row is checked, but nothing has changed yet, so there is nothing to save.
    const confirm = screen.getByRole('button', { name: /add 0 items|add items/i })
    expect(confirm).toBeDisabled()

    fireEvent.click(checkboxFor('Meeting notes'))
    expect(screen.getByRole('button', { name: /add 1 item/i })).toBeEnabled()
  })

  it('still behaves as an add-only picker when the caller holds nothing', () => {
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
        actionVerb="Attach"
      />,
    )

    expect(checkboxFor('Q3 report').checked).toBe(false)
    fireEvent.click(checkboxFor('Q3 report'))
    fireEvent.click(screen.getByRole('button', { name: /attach 1 item/i }))

    expect(onSelect).toHaveBeenCalledWith([REPORT], [])
  })
})

// A connector binding holds one folder and one file, so the picker that fills
// one has to behave like a radio per kind rather than a checklist. Without it
// the second tick was accepted on screen and dropped on confirm.
describe('FilePicker — singlePerKind', () => {
  const folderRow = (id: string, title: string): BrowseResult =>
    ({ id, title, contentType: 'folder' }) as BrowseResult

  const MARKETING = folderRow('folder-marketing', 'Marketing')
  const SALES = folderRow('folder-sales', 'Sales')

  const folderCheckboxFor = (title: string): HTMLInputElement => {
    const row = screen.getByText(title).closest('.file-picker__folder')
    if (!row) throw new Error(`no folder row for ${title}`)
    const box = row.querySelector('input[type="checkbox"]')
    if (!box) throw new Error(`no checkbox for ${title}`)
    return box as HTMLInputElement
  }

  const withRows = (rows: BrowseResult[]) => {
    mockUseBrowseConnector.mockReturnValue({
      data: { pages: [{ results: rows }] },
      isPending: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    })
  }

  it('ticking a second file unticks the first', () => {
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        singlePerKind
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    fireEvent.click(checkboxFor('Q3 report'))
    fireEvent.click(checkboxFor('Meeting notes'))

    expect(checkboxFor('Q3 report').checked).toBe(false)
    expect(checkboxFor('Meeting notes').checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /add 1 item/i }))
    expect(onSelect).toHaveBeenCalledWith([NOTES], [])
  })

  it('ticking a second folder unticks the first', () => {
    withRows([MARKETING, SALES])
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        singlePerKind
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    fireEvent.click(folderCheckboxFor('Marketing'))
    fireEvent.click(folderCheckboxFor('Sales'))

    expect(folderCheckboxFor('Marketing').checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /add 1 item/i }))
    expect(onSelect).toHaveBeenCalledWith([SALES], [])
  })

  it('holds a folder and a file at the same time, because they answer different picks', () => {
    withRows([MARKETING, REPORT])
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        singlePerKind
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    fireEvent.click(folderCheckboxFor('Marketing'))
    fireEvent.click(checkboxFor('Q3 report'))

    expect(folderCheckboxFor('Marketing').checked).toBe(true)
    expect(checkboxFor('Q3 report').checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /add 2 items/i }))
    expect(onSelect).toHaveBeenCalledWith([MARKETING, REPORT], [])
  })

  it('replaces a pick that arrived already ticked', () => {
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        singlePerKind
        alreadySelectedIds={[REPORT.id]}
        alreadySelectedKind="file"
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    fireEvent.click(checkboxFor('Meeting notes'))

    expect(checkboxFor('Q3 report').checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(onSelect).toHaveBeenCalledWith([NOTES], [REPORT.id])
  })

  it('leaves a pick of the other kind alone when it arrived already ticked', () => {
    withRows([MARKETING, REPORT])
    const onSelect = vi.fn()
    render(
      <FilePicker
        connectorId="conn-1"
        singlePerKind
        alreadySelectedIds={[MARKETING.id]}
        alreadySelectedKind="folder"
        onSelect={onSelect}
        onClose={vi.fn()}
        isBusy={false}
      />,
    )

    fireEvent.click(checkboxFor('Q3 report'))

    expect(folderCheckboxFor('Marketing').checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /add 1 item/i }))
    expect(onSelect).toHaveBeenCalledWith([REPORT], [])
  })
})
