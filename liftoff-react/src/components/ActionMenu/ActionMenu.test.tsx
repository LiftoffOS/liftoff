// ActionMenu is shared by every list surface in the dashboard, so the badge had
// to be additive: an item that does not ask for one must render exactly as it
// did before.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ActionMenu from './ActionMenu'

function openMenu(items: Parameters<typeof ActionMenu>[0]['items']) {
  render(<ActionMenu items={items} />)
  return userEvent.click(screen.getByRole('button', { name: 'More options' }))
}

describe('ActionMenu badge', () => {
  it('renders the dot for a badged item', async () => {
    await openMenu([{ label: 'Message Team', onClick: vi.fn(), badge: true }])

    const item = screen.getByRole('button', { name: /Message Team/ })
    expect(item.querySelector('.action-menu__item-dot')).toBeInTheDocument()
  })

  it('renders nothing extra when badge is omitted', async () => {
    await openMenu([{ label: 'Message Team', onClick: vi.fn() }])

    expect(document.querySelector('.action-menu__item-dot')).toBeNull()
    expect(screen.queryByText('Unread replies')).toBeNull()
  })

  it('carries the state in the accessible name, not in colour alone', async () => {
    await openMenu([{ label: 'Message Team', onClick: vi.fn(), badge: true }])

    expect(
      screen.getByRole('button', { name: /Message Team.*Unread replies/ }),
    ).toBeInTheDocument()
  })

  it('leaves the label itself untouched', async () => {
    await openMenu([{ label: 'Message Team', onClick: vi.fn(), badge: true }])

    // The dot is added beside the label. The copy is not rewritten.
    expect(screen.getByText('Message Team')).toBeInTheDocument()
  })

  it('still renders and fires unbadged items alongside a badged one', async () => {
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(
      <ActionMenu
        items={[
          { label: 'Message Team', onClick: vi.fn(), badge: true },
          { label: 'Update Team', onClick: onUpdate },
          { label: 'Archive Team', onClick: vi.fn(), variant: 'danger' },
        ]}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'More options' }))

    expect(screen.getByText('Update Team')).toBeInTheDocument()
    expect(screen.getByText('Archive Team')).toBeInTheDocument()
    expect(document.querySelectorAll('.action-menu__item-dot')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Update Team' }))
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })
})

// The trigger is an icon alone. Beside it in a teams row sits a chat button
// that names itself on hover, and the kebab has to answer the same way.
describe('ActionMenu trigger tooltip', () => {
  const portal = () => document.querySelector('.tooltip-portal')

  it('names the trigger on hover and stops naming it on leave', async () => {
    const user = userEvent.setup()
    render(<ActionMenu items={[{ label: 'Update Team', onClick: vi.fn() }]} />)

    expect(portal()).toHaveTextContent('More Options')
    expect(portal()?.className).not.toContain('tooltip-portal--visible')

    await user.hover(screen.getByRole('button', { name: 'More options' }))
    expect(portal()?.className).toContain('tooltip-portal--visible')

    await user.unhover(screen.getByRole('button', { name: 'More options' }))
    expect(portal()?.className).not.toContain('tooltip-portal--visible')
  })

  it('leaves the accessible name to ariaLabel, so a caller can still name what it acts on', () => {
    render(<ActionMenu items={[{ label: 'Update Team', onClick: vi.fn() }]} ariaLabel="Actions for Payroll" />)

    expect(screen.getByRole('button', { name: 'Actions for Payroll' })).toBeInTheDocument()
    expect(portal()).toHaveTextContent('More Options')
  })

  it('still opens the menu through the wrapper', async () => {
    const user = userEvent.setup()
    render(<ActionMenu items={[{ label: 'Update Team', onClick: vi.fn() }]} />)

    await user.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByText('Update Team')).toBeInTheDocument()
  })
})
