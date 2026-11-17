// The source chooser at /dashboard/switch.
//
// This page is entirely about where its controls lead, so that is what is
// pinned. A wrong destination here is invisible to typecheck and lint and only
// shows up as someone landing on the wrong screen.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import SwitchLanding from './SwitchLanding'

const navigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => navigate }
})
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }))

function renderPage() {
  return render(
    <MemoryRouter>
      <SwitchLanding />
    </MemoryRouter>,
  )
}

beforeEach(() => navigate.mockClear())

describe('the source chooser', () => {
  it('says what the page is for', () => {
    renderPage()
    expect(screen.getByText('Move Your Local AI Setup to Liftoff')).toBeInTheDocument()
  })

  it('opens the OpenClaw wizard', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'OpenClaw' }))
    expect(navigate).toHaveBeenCalledWith('/dashboard/switch/openclaw')
  })

  it('opens the Hermes wizard', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Hermes' }))
    expect(navigate).toHaveBeenCalledWith('/dashboard/switch/hermes')
  })

  it('goes back to Explore, where the entry point lives', async () => {
    // Not the teams list: this page is reached from Explore, and back should
    // undo the step the person actually took.
    renderPage()
    const back = screen.getAllByRole('button')[0]
    await userEvent.click(back)
    expect(navigate).toHaveBeenCalledWith('/dashboard/agents/explore')
  })
})
