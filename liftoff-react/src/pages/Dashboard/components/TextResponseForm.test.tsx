// TextResponseForm — extracted from the reject flow. Tests verify that the
// extraction preserves reject-flow behaviour AND covers the new clarification
// flow's use of the same component.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TextResponseForm } from './TextResponseForm'

describe('TextResponseForm', () => {
  it('renders the textarea + cancel + confirm with default labels', () => {
    render(
      <TextResponseForm
        value=""
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        placeholder="Type your reply…"
      />,
    )
    expect(screen.getByPlaceholderText('Type your reply…')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
    expect(screen.getByText('Confirm')).toBeInTheDocument()
  })

  it('uses the supplied confirmLabel', () => {
    render(
      <TextResponseForm
        value=""
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        confirmLabel="Send"
      />,
    )
    expect(screen.getByText('Send')).toBeInTheDocument()
  })

  it('shows the "Working..." state when confirming=true and disables buttons', () => {
    render(
      <TextResponseForm
        value="hi"
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        confirmLabel="Send"
        confirming
      />,
    )
    expect(screen.getByText('Working...')).toBeInTheDocument()
    expect(screen.getByText('Cancel').closest('button')).toBeDisabled()
    expect(screen.getByText('Working...').closest('button')).toBeDisabled()
  })

  it('renders the label text when supplied (reject flow uses this)', () => {
    render(
      <TextResponseForm
        value=""
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        label="Rejection reason (optional)"
      />,
    )
    expect(screen.getByText('Rejection reason (optional)')).toBeInTheDocument()
  })

  it('renders extraControls between textarea and action row (reject flow passes the always-apply checkbox here)', () => {
    render(
      <TextResponseForm
        value=""
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        extraControls={<div data-testid="always-apply">always-apply checkbox</div>}
      />,
    )
    expect(screen.getByTestId('always-apply')).toBeInTheDocument()
  })

  it('calls onChange for textarea input, onCancel for Cancel, onConfirm for Confirm', () => {
    const onChange = vi.fn()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <TextResponseForm
        value=""
        onChange={onChange}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'reply' } })
    expect(onChange).toHaveBeenCalledWith('reply')

    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('preserves the reject-form__* CSS class names so existing styles still apply', () => {
    const { container } = render(
      <TextResponseForm
        value=""
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(container.querySelector('.reject-form__label')).toBeTruthy()
    expect(container.querySelector('.reject-form__textarea')).toBeTruthy()
    expect(container.querySelector('.reject-form__actions')).toBeTruthy()
  })
})
