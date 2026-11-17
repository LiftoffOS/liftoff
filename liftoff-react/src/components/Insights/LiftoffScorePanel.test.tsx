import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import LiftoffScorePanel from './LiftoffScorePanel'
import type { LiftoffScoreEntry, LiftoffScoreResponse } from '../../types/liftoffScore'

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

// src/test/setup.ts does not register testing-library's cleanup, so without
// this every render in this file stacks in the same document and getByText
// starts finding duplicates from earlier cases.
afterEach(cleanup)

// GuestAvatar wraps itself in a Tooltip whose text is the same display name, so
// the name exists twice in the DOM. Pick the row heading, not the tooltip.
function rowFor(name: string): HTMLElement {
  const el = screen
    .getAllByText(name)
    .find(n => n.classList.contains('lscore__name'))
  if (!el) throw new Error(`no row named ${name}`)
  return el.closest('li') as HTMLElement
}


function entry(over: Partial<LiftoffScoreEntry> = {}): LiftoffScoreEntry {
  return {
    entityKey: 'ai:1', kind: 'ai_team', group: 'ai', displayName: 'Finance Agent',
    accountId: null, email: null, taskCount: 61, score: 82, band: 'strong',
    confidence: 'high', resultsBand: 'strong', teamworkBand: 'good',
    drivers: [
      { kind: 'helping', dimension: 'results', label: '9 in 10 tasks accepted first time', benchmark: null },
      { kind: 'hurting', dimension: 'teamwork', label: 'Takes 2.1 rounds of back and forth per task', benchmark: '(best here: 1.2)' },
    ],
    action: {
      label: 'Grant access to Google Sheets',
      href: '/dashboard/connections',
      hoursSavedPerMonth: 4,
      evidence: { quote: 'Share the billing sheet with the service account.', occurrences: 6 },
    },
    rated: true, notRatedReason: null, tasksToRate: null,
    ...over,
  }
}

function response(over: Partial<LiftoffScoreResponse> = {}): LiftoffScoreResponse {
  return {
    period: 'this_month', status: 'ok', taskCount: 214,
    computedAt: '2026-08-23T04:00:11Z',
    groups: [
      { key: 'ai', ratedCount: 1, hoursSavedPerMonthAvailable: 25 },
      { key: 'person', ratedCount: 1, hoursSavedPerMonthAvailable: 5 },
    ],
    entries: [
      entry(),
      // Distinct driver text, so getByText assertions above stay unambiguous.
      entry({
        entityKey: 'p:1', kind: 'person', group: 'person', displayName: 'Sarah Chen',
        accountId: 'acct_1', email: 's@example.com', taskCount: 38, score: 78,
        action: null,
        drivers: [
          { kind: 'helping', dimension: 'teamwork', label: 'Gives the full picture up front', benchmark: null },
        ],
      }),
    ],
    ...over,
  }
}

describe('LiftoffScorePanel', () => {
  it('shows the score with the band that gives it meaning', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    expect(screen.getByText('82')).toBeInTheDocument()
    expect(screen.getAllByText('Strong').length).toBeGreaterThan(0)
  })

  it('states the basis once per row, not once per dimension', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    expect(screen.getByText(/Based on 61 tasks, confident/)).toBeInTheDocument()
  })

  it('gives the two halves as words rather than a second pair of numbers', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    const row = rowFor('Finance Agent')
    // The halves render as label + band word in one span, so read the row.
    expect(row.textContent).toMatch(/Results\s*strong/)
    expect(row.textContent).toMatch(/Teamwork\s*good/)
  })

  it('renders every driver as a sentence in real units', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    expect(screen.getByText(/9 in 10 tasks accepted first time/)).toBeInTheDocument()
    expect(screen.getByText(/Takes 2.1 rounds of back and forth per task/)).toBeInTheDocument()
    expect(screen.getByText(/\(best here: 1.2\)/)).toBeInTheDocument()
  })

  it('shows the next step with its payoff', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    expect(screen.getByRole('link', { name: 'Grant access to Google Sheets' })).toBeInTheDocument()
    expect(screen.getByText(/frees ~4 hrs\/month/)).toBeInTheDocument()
  })

  it('says so explicitly when a row needs no action', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    const row = rowFor('Sarah Chen')
    expect(within(row).getByText('Nothing to change right now')).toBeInTheDocument()
  })

  it('quotes the team rather than paraphrasing it', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    expect(screen.getByText(/It asked 6 times/)).toBeInTheDocument()
    expect(
      screen.getByText(/Share the billing sheet with the service account\./),
    ).toBeInTheDocument()
  })

  it('surfaces the hours the group has available', () => {
    render(<LiftoffScorePanel data={response()} isLoading={false} />)
    expect(screen.getByText(/~25 hrs\/month available/)).toBeInTheDocument()
  })

  it('never renders a score for an unrated teammate', () => {
    const data = response({
      entries: [
        entry(),
        entry({
          entityKey: 'p:9', kind: 'person', group: 'person', displayName: 'Dana Whitfield',
          accountId: 'acct_9', email: 'd@example.com', taskCount: 5, score: null,
          band: null, confidence: null, resultsBand: null, teamworkBand: null,
          drivers: [], action: null, rated: false, notRatedReason: 'single_partner',
        }),
      ],
    })
    render(<LiftoffScorePanel data={data} isLoading={false} />)
    const row = rowFor('Dana Whitfield')
    expect(row.textContent).toMatch(/one teammate/i)
    expect(row.textContent).not.toMatch(/\b\d{2}\b/)
  })

  it('renders the too-early notice and no rows', () => {
    render(<LiftoffScorePanel data={response({ status: 'too_early', entries: [], groups: [] })} isLoading={false} />)
    expect(screen.getByText('Not enough work scored yet')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('withholds everything when the workspace splits into islands', () => {
    render(<LiftoffScorePanel data={response({ status: 'on_hold', entries: [], groups: [] })} isLoading={false} />)
    expect(screen.getByText('Scores are on hold')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('renders nothing without data', () => {
    const { container } = render(<LiftoffScorePanel data={undefined} isLoading={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('holds the copy invariants: no "AI team" in user text, no em dashes in prose', () => {
    // Inverted with INV-UI-003: "agent" is the product's word now, and the
    // retired noun is the one that may not reach a reader.
    const { container } = render(<LiftoffScorePanel data={response()} isLoading={false} />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bAI teams?\b/i)
  })
})
