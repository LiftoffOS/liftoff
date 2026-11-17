import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RunProgressGroup } from './RunProgressGroup'

const lines = [
  { id: 'a', content: 'This run is still working. Step 2 of 4.' },
  { id: 'b', content: 'This run is still working. Step 3 of 4.' },
  { id: 'c', content: 'This run took 1 minute. Work done: 6 actions.' },
]

describe('a run that was answered', () => {
  it('folds, so the thread ends on the answer rather than on housekeeping', () => {
    render(<RunProgressGroup lines={lines} label={lines[2].content} answered />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('This run is still working. Step 2 of 4.')).not.toBeInTheDocument()
  })

  it('shows the run’s own closing summary as the folded line', () => {
    render(<RunProgressGroup lines={lines} label={lines[2].content} answered />)
    expect(screen.getByRole('button')).toHaveTextContent('This run took 1 minute')
  })

  it('says how much is behind the line', () => {
    render(<RunProgressGroup lines={lines} label={lines[2].content} answered />)
    expect(screen.getByRole('button')).toHaveTextContent('3 updates')
  })

  it('opens on click and shows every line, in order', () => {
    // Nothing is lost by folding: the running account is still there.
    render(<RunProgressGroup lines={lines} label={lines[2].content} answered />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('This run is still working. Step 2 of 4.')).toBeInTheDocument()
    expect(screen.getByText('This run is still working. Step 3 of 4.')).toBeInTheDocument()
  })
})

describe('a run that was NOT answered', () => {
  it('stays open, because a dead turn must not look like a quiet one', () => {
    // "Three states, one appearance" is the bug these rows exist to kill.
    // Folding a failure away would bring it straight back.
    render(<RunProgressGroup lines={lines} label={lines[2].content} answered={false} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('This run is still working. Step 2 of 4.')).toBeInTheDocument()
  })

  it('stays open while the run is still going', () => {
    const live = lines.slice(0, 2)
    render(<RunProgressGroup lines={live} label={live[1].content} answered={false} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('a run with one line', () => {
  it('renders as a plain row, with nothing to click', () => {
    // A disclosure control here would add a click to reach text already fully
    // visible.
    render(<RunProgressGroup lines={[lines[2]]} label={lines[2].content} answered />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('This run took 1 minute')
  })
})

describe('how it is announced', () => {
  it('reports politely rather than interrupting', () => {
    // Same reason the single row uses `status`: a line appended every twenty
    // seconds must not interrupt a screen-reader user each time.
    render(<RunProgressGroup lines={lines} label={lines[2].content} answered />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
