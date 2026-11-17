// The status line a colleague's thread keeps when another assistant brought
// it in. The brief itself is one model's note to another and is never
// rendered: not from a new row (the backend no longer stores it) and not from
// an old one (which still carries it after a blank line).

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ForwardedContextRow, FORWARDED_CONTEXT_MESSAGE_TYPE } from './ForwardedContextRow'

const STATUS = 'Insights Manager shared background from the conversation so far'
const OLD_ROW = [
  'Liftoff shared background from the conversation so far',
  '',
  'Alex wants the agent "Support Triage" (id 122662dd-de4e-4b0d-8873-50cd6a00daaf) changed; confirm you are targeting that id.',
].join('\n')

describe('ForwardedContextRow', () => {
  it('renders the status line as a quiet status row, attributed to whoever forwarded it', () => {
    const { container } = render(
      <ForwardedContextRow content={STATUS} contributors={[{ id: 'insights', label: 'Insights Manager' }]} />,
    )

    const row = container.querySelector('.chat-page__hitl-status')
    expect(row).toBeInTheDocument()
    expect(row).toHaveAttribute('role', 'status')
    expect(row?.querySelector('.chat-page__hitl-status__dot')).toBeInTheDocument()
    // The last word is held on one line with the chip, so the sentence spans
    // two nodes and is read off the row.
    expect(row?.textContent).toContain(STATUS)
    // The same chip a reply's contributors get, after the sentence.
    expect(row?.querySelector('.chat-message__sender-avatar')).toHaveTextContent('IM')
    expect(screen.getByLabelText('Insights Manager')).toBeInTheDocument()
    expect(screen.queryByLabelText('Liftoff')).not.toBeInTheDocument()
    // Nothing to expand, no bubble.
    expect(container.querySelector('details')).not.toBeInTheDocument()
    expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument()
  })

  it('shows only the status line of a row written before the brief stopped being stored', () => {
    const { container } = render(<ForwardedContextRow content={OLD_ROW} />)

    expect(container.textContent).toContain('Liftoff shared background from the conversation so far')
    expect(container.textContent).not.toContain('122662dd')
    expect(container.textContent).not.toContain('Alex wants')
    expect(container.textContent).not.toContain('confirm you are targeting')
  })

  it('falls back to Liftoff for a row written before the forwarder was stamped', () => {
    // Every forwarded row before the field existed was Liftoff's; an empty
    // list and an absent one both read as that rather than as no chip.
    for (const contributors of [undefined, []]) {
      const { container, unmount } = render(<ForwardedContextRow content={OLD_ROW} contributors={contributors} />)
      expect(container.querySelector('.chat-message__sender-avatar')).toHaveTextContent('L')
      expect(screen.getByLabelText('Liftoff')).toBeInTheDocument()
      unmount()
    }
  })

  it('never renders a line that is not a status line, whatever a row holds', () => {
    // No backend writes such a row. If one ever did, the label is shown and
    // the content is not: the rule is that nothing but provenance reaches the
    // screen.
    const { container } = render(
      <ForwardedContextRow content={'Confirm you are targeting id 122662dd-de4e-4b0d-8873-50cd6a00daaf.\n\nmore'} />,
    )
    expect(container.textContent).toContain('Liftoff shared background from the conversation so far')
    expect(container.textContent).not.toContain('122662dd')

    const empty = render(<ForwardedContextRow content="" />)
    expect(empty.container.textContent).toContain('Liftoff shared background from the conversation so far')
    empty.unmount()
    const withBody = render(<ForwardedContextRow content={`${STATUS}\n\nbody`} />)
    expect(withBody.container.textContent).toContain(STATUS)
    expect(withBody.container.textContent).not.toContain('body')
  })

  it('exports the type marker the backend writes', () => {
    // Three services agree on this string. A rename on one side that misses the
    // others silently renders the note as speech again.
    expect(FORWARDED_CONTEXT_MESSAGE_TYPE).toBe('forwarded_context')
  })
})
