// The receiving half of "Inspect Team": /dashboard/activity picks the team name
// up out of router state and types it into the search box for the user. Nothing
// about the search box itself changes — it is the same control, with a value in
// it. The address bar must never learn about any of it, so the path stays bare
// and the query string stays empty.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import ActivityPage from './ActivityPage'
import type { ActivityLogFilters } from '../../services/activityLogs'

const { capturedFilters } = vi.hoisted(() => ({ capturedFilters: [] as (ActivityLogFilters | undefined)[] }))

vi.mock('../../hooks/useActivityLogs', () => ({
  useActivityLogs: (filters?: ActivityLogFilters) => {
    capturedFilters.push(filters)
    return {
      data: { pages: [{ items: [], cursor: null, hasMore: false, total: 0 }] },
      isLoading: false,
      isPending: false,
      isError: false,
      error: null,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    }
  },
}))

vi.mock('../../hooks/useCorrections', () => ({
  useCorrectionOptions: () => ({ data: undefined, isLoading: false }),
  useCorrectionHistory: () => ({ data: undefined }),
  useRequestCorrection: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('../../hooks/useRerunRun', () => ({
  useRerunRun: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))
vi.mock('../../services/auditEvents', () => ({ reportAuditEvent: vi.fn() }))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

/** Mirrors the live address so tests can assert the URL stayed clean. */
function AddressProbe() {
  const location = useLocation()
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>
}

function renderPage(teamSearch?: string) {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: '/dashboard/activity', state: teamSearch ? { teamSearch } : null }]}
    >
      <ActivityPage />
      <AddressProbe />
    </MemoryRouter>,
  )
}

/** The one search box on the page. */
function searchBox() {
  return screen.getByPlaceholderText('Search by team, action, input, or output...')
}

/** The filters handed to the query on the most recent render. */
function latestFilters() {
  return capturedFilters[capturedFilters.length - 1]
}

beforeEach(() => {
  capturedFilters.length = 0
})

describe('ActivityPage "Inspect Team" arrival', () => {
  it('lands with the team name already in the search box', () => {
    renderPage('Sales Team')

    expect(searchBox()).toHaveValue('Sales Team')
  })

  it('searches on it from the very first request, with no unscoped fetch first', () => {
    renderPage('Sales Team')

    expect(capturedFilters[0]?.q).toBe('Sales Team')
    expect(latestFilters()?.q).toBe('Sales Team')
  })

  it('reflects the term in the result count', () => {
    renderPage('Sales Team')

    expect(screen.getByText(/matching "Sales Team"/)).toBeInTheDocument()
  })

  it('leaves the search box empty when the page is opened directly', () => {
    renderPage()

    expect(searchBox()).toHaveValue('')
    expect(latestFilters()?.q).toBeUndefined()
  })

  it('keeps the address bare, with no name and no query string', () => {
    renderPage('Sales Team')

    expect(screen.getByTestId('address')).toHaveTextContent('/dashboard/activity')
    expect(screen.getByTestId('address').textContent).not.toContain('?')
    expect(screen.getByTestId('address').textContent).not.toContain('Sales Team')
  })

  it('is an ordinary search the user can edit or clear', async () => {
    const user = userEvent.setup()
    renderPage('Sales Team')

    // The search box's own clear button, unchanged by any of this.
    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(searchBox()).toHaveValue('')
  })
})
