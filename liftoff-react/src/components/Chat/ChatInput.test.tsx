import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import ChatInput from './ChatInput'

// The composer has two jobs while a turn is running: let the person end the run,
// and let them steer it. Which button is showing decides which one they get, so
// the swap is the contract worth pinning (ADR-041).

const baseProps = {
  value: '',
  onChange: vi.fn(),
  onSend: vi.fn(),
  disabled: false,
  placeholder: 'Message the team...',
}

describe('ChatInput', () => {
  it('shows Send when no turn is running', () => {
    render(<ChatInput {...baseProps} value="hello" />)
    expect(screen.getByLabelText('Send message')).toBeInTheDocument()
    expect(screen.queryByLabelText('Stop the current run')).not.toBeInTheDocument()
  })

  it('shows Stop while a turn is running and the composer is empty', () => {
    render(<ChatInput {...baseProps} onStop={vi.fn()} canSendDuringRun />)
    expect(screen.getByLabelText('Stop the current run')).toBeInTheDocument()
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument()
  })

  it('swaps Stop back for Send once the person types during a run', () => {
    // What they want is to steer the reply, not end it.
    render(<ChatInput {...baseProps} value="actually, make it cheaper" onStop={vi.fn()} canSendDuringRun />)
    expect(screen.getByLabelText('Send message')).toBeInTheDocument()
    expect(screen.queryByLabelText('Stop the current run')).not.toBeInTheDocument()
  })

  it('keeps Stop for the whole run when whitespace is all that was typed', () => {
    render(<ChatInput {...baseProps} value="   " onStop={vi.fn()} canSendDuringRun />)
    expect(screen.getByLabelText('Stop the current run')).toBeInTheDocument()
  })

  it('leaves the textarea usable while a turn is running', () => {
    // Disabling it mid-stream is what made mid-run messages impossible; the
    // pages now pass a much narrower `disabled`.
    render(<ChatInput {...baseProps} onStop={vi.fn()} canSendDuringRun />)
    expect(screen.getByPlaceholderText('Message the team...')).not.toBeDisabled()
  })

  it('disables the textarea when the page says the composer is busy', () => {
    render(<ChatInput {...baseProps} disabled />)
    expect(screen.getByPlaceholderText('Message the team...')).toBeDisabled()
  })

  it('sends on Enter and calls onStop when Stop is pressed', () => {
    const onSend = vi.fn()
    const onStop = vi.fn()
    const { rerender } = render(<ChatInput {...baseProps} value="hi" onSend={onSend} />)
    fireEvent.keyDown(screen.getByPlaceholderText('Message the team...'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalled()

    rerender(<ChatInput {...baseProps} value="" onSend={onSend} onStop={onStop} canSendDuringRun />)
    fireEvent.click(screen.getByLabelText('Stop the current run'))
    expect(onStop).toHaveBeenCalled()
  })
})
