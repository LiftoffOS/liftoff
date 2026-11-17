// The card is the approver's trust anchor, so what it shows has to be what
// happens — before the decision AND after it.
//
// The gap these exist to close: `edited_tool_inputs` reached the browser and
// nothing rendered it, so a call a person had rewritten displayed as the AI
// team's untouched draft. Every layer carried the value and none showed it,
// which reads exactly like a review that changed nothing.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolCallDetails } from './ToolCallDetails'
import type { PendingToolCall } from '../../../services/oversight'

const CALLS: PendingToolCall[] = [
  { id: 'tc-1', name: 'slack__send_message', input: { text: 'agent draft', channel: 'C1' } },
]

describe('a decision still open', () => {
  it('offers the editor when there is somewhere to send the edit', () => {
    render(<ToolCallDetails calls={CALLS} onEdit={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('offers no editor on a read-only card', () => {
    // A card with nowhere to send an edit must not invite one.
    render(<ToolCallDetails calls={CALLS} />)
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('reports the whole input, not just the field that changed', async () => {
    const onEdit = vi.fn()
    render(<ToolCallDetails calls={CALLS} onEdit={onEdit} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.type(screen.getByLabelText('Text'), '!')

    expect(onEdit).toHaveBeenLastCalledWith('tc-1', {
      text: 'agent draft!',
      channel: 'C1',
    })
  })

  it('does not call an open decision "changed by the approver"', () => {
    render(<ToolCallDetails calls={CALLS} onEdit={vi.fn()} edits={{ 'tc-1': { text: 'mine' } }} />)
    expect(screen.queryByText('Changed by the approver')).not.toBeInTheDocument()
  })
})

describe('a decision already made', () => {
  const decided = () =>
    render(
      <ToolCallDetails
        calls={CALLS}
        edits={{ 'tc-1': { text: 'their wording', channel: 'C1' } }}
        editsAreRecorded
      />,
    )

  it('shows what was sent, not what the agent drafted', () => {
    decided()
    expect(screen.getByText('their wording')).toBeInTheDocument()
    expect(screen.queryByText('agent draft')).not.toBeInTheDocument()
  })

  it('says a person changed it, so an audit is not misread', () => {
    decided()
    expect(screen.getByText('Changed by the approver')).toBeInTheDocument()
  })

  it('offers no editor, since nothing can be changed now', () => {
    decided()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('leaves an untouched call reading as the agent wrote it', () => {
    render(<ToolCallDetails calls={CALLS} edits={{}} editsAreRecorded />)
    expect(screen.getByText('agent draft')).toBeInTheDocument()
    expect(screen.queryByText('Changed by the approver')).not.toBeInTheDocument()
  })
})
