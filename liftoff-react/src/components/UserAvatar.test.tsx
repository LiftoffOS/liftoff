// A photo that will not load must fall back the same way as a photo we never
// had. Without this the circle renders empty and stays empty until the component
// remounts, which is indistinguishable from the photo being gone — and it is the
// state a rotated Firebase Storage download token leaves every surface in.
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import UserAvatar from './UserAvatar'

const person = {
  accountId: 'acc-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  avatarUrl: 'https://firebasestorage.googleapis.com/v0/b/b/o/profile-photos%2Fu%2Fx?alt=media&token=t',
}

describe('UserAvatar', () => {
  it('shows the photo while it loads', () => {
    render(<UserAvatar person={person} />)

    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveAttribute(
      'src',
      person.avatarUrl,
    )
  })

  it('falls back to initials once the photo fails to load', () => {
    render(<UserAvatar person={person} />)

    fireEvent.error(screen.getByRole('img', { name: 'Ada Lovelace' }))

    expect(screen.queryByRole('img', { name: 'Ada Lovelace' })?.tagName).not.toBe('IMG')
    expect(screen.getByText('AL')).toBeInTheDocument()
  })

  it('falls back to the person icon when the photo fails and no name is held', () => {
    render(
      <UserAvatar person={{ accountId: 'acc-2', email: 'x@example.com', avatarUrl: person.avatarUrl }} />,
    )

    fireEvent.error(screen.getByRole('img'))

    expect(document.querySelector('.user-avatar--icon')).toBeInTheDocument()
  })

  it('retries a photo that changes rather than inheriting the previous failure', () => {
    const { rerender } = render(<UserAvatar person={person} />)
    fireEvent.error(screen.getByRole('img', { name: 'Ada Lovelace' }))
    expect(screen.getByText('AL')).toBeInTheDocument()

    const replaced = `${person.avatarUrl}&v=2`
    rerender(<UserAvatar person={{ ...person, avatarUrl: replaced }} />)

    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveAttribute('src', replaced)
  })
})
