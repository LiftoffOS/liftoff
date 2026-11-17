// The status line every chat surface draws for a row about the conversation.
// It wraps as one sentence: the dot stays with the first word and the chips
// with the last, so a narrow column never leaves either on a line of its own.

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusRow } from './StatusRow'

describe('StatusRow', () => {
  it('draws the dot and the sentence as one text flow', () => {
    const { container } = render(<StatusRow text="Ada handed the browser back" />)

    const row = container.querySelector('.chat-page__hitl-status')
    expect(row).toHaveAttribute('role', 'status')
    expect(row?.firstElementChild).toHaveClass('chat-page__hitl-status__dot')
    expect(screen.getByText('Ada handed the browser back')).toBeInTheDocument()
  })

  it('keeps the last word on one line with the chips', () => {
    const { container } = render(
      <StatusRow text="Liftoff shared background" attribution={<span data-testid="chip" />} />,
    )

    const glue = container.querySelector('.chat-page__hitl-status__glue')
    expect(glue?.textContent).toBe('background')
    expect(glue).toContainElement(screen.getByTestId('chip'))
    expect(container.querySelector('.chat-page__hitl-status')?.textContent).toBe('Liftoff shared background')
  })

  it('holds a one-word sentence whole with its chips', () => {
    const { container } = render(<StatusRow text="Liftoff" attribution={<span data-testid="chip" />} />)

    const glue = container.querySelector('.chat-page__hitl-status__glue')
    expect(glue?.textContent).toBe('Liftoff')
    expect(glue).toContainElement(screen.getByTestId('chip'))
  })

  it('leaves what follows the sentence free to wrap', () => {
    const { container } = render(
      <StatusRow text="Support Team is waiting on an approval">
        <button type="button">Open Review Queue</button>
      </StatusRow>,
    )

    expect(container.querySelector('.chat-page__hitl-status__glue')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Review Queue' })).toBeInTheDocument()
  })
})
