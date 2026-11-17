// DropdownOption.badge — an optional StatusBadge pill rendered after the
// label inside the menu. The trigger deliberately stays plain text, so the
// badge must appear only once the menu is open and must never leak into the
// closed control.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dropdown } from './Dropdown'

const OPTIONS = [
  { value: 'default', label: 'Liftoff Managed', badge: 'Recommended' },
  { value: 'anthropic', label: 'Anthropic' },
]

describe('Dropdown option badge', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView, used by the Dropdown component
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('does not render the badge while the menu is closed', () => {
    render(<Dropdown options={OPTIONS} value="default" onChange={vi.fn()} />)
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument()
  })

  it('renders the badge next to its label once the menu is open', async () => {
    const user = userEvent.setup()
    render(<Dropdown options={OPTIONS} value="default" onChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Liftoff Managed/ }))

    const badge = screen.getByText('Recommended')
    expect(badge).toBeInTheDocument()
    // Lives inside the option row, not somewhere else in the menu.
    expect(badge.closest('[role="option"]')).toHaveTextContent('Liftoff Managed')
  })

  it('leaves options without a badge untouched', async () => {
    const user = userEvent.setup()
    render(<Dropdown options={OPTIONS} value="default" onChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Liftoff Managed/ }))

    const plain = screen.getByRole('option', { name: 'Anthropic' })
    expect(plain.querySelector('.status-badge')).toBeNull()
  })

  it('still selects by value when the option carries a badge', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Dropdown options={OPTIONS} value="anthropic" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Anthropic/ }))
    await user.click(screen.getByRole('option', { name: /Liftoff Managed/ }))

    expect(onChange).toHaveBeenCalledWith('default')
  })
})
