// AutonomyControl renders the three real autonomy levels, no more. "Inherit"
// is not a fourth option: the level the workspace is set to carries a
// "Workspace Default" badge, and choosing it clears the override (null) rather
// than pinning that same level.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AutonomyControl } from './AutonomyControl'
import { AUTONOMY_LABELS } from './autonomyLabels'

const optionFor = (label: string) => screen.getByText(label).closest('button')!

describe('AutonomyControl', () => {
  it('renders exactly the three levels and no separate inherit row', () => {
    render(<AutonomyControl value={null} onChange={vi.fn()} workspaceDefault="balanced" />)

    expect(screen.getAllByRole('button')).toHaveLength(3)
    for (const label of Object.values(AUTONOMY_LABELS)) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.queryByText('Workspace default')).not.toBeInTheDocument()
  })

  it('badges only the level the workspace is set to', () => {
    render(<AutonomyControl value={null} onChange={vi.fn()} workspaceDefault="balanced" />)

    expect(screen.getAllByText('Workspace Default')).toHaveLength(1)
    expect(screen.getByText('Workspace Default').closest('button')).toBe(optionFor('Balanced'))
  })

  it('shows the inherited level as selected when there is no override', () => {
    render(<AutonomyControl value={null} onChange={vi.fn()} workspaceDefault="controlled" />)

    expect(optionFor('More controlled')).toHaveClass('autonomy-control__option--active')
    expect(optionFor('Balanced')).not.toHaveClass('autonomy-control__option--active')
  })

  it('shows the override as selected when one is set', () => {
    render(<AutonomyControl value="autonomous" onChange={vi.fn()} workspaceDefault="balanced" />)

    expect(optionFor('More autonomous')).toHaveClass('autonomy-control__option--active')
    expect(optionFor('Balanced')).not.toHaveClass('autonomy-control__option--active')
  })

  it('clears the override when the workspace level is chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AutonomyControl value="controlled" onChange={onChange} workspaceDefault="balanced" />)

    await user.click(optionFor('Balanced'))

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('sets an override when any other level is chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AutonomyControl value={null} onChange={onChange} workspaceDefault="balanced" />)

    await user.click(optionFor('More controlled'))

    expect(onChange).toHaveBeenCalledWith('controlled')
  })

  it('badges and highlights nothing until the workspace level resolves', () => {
    render(<AutonomyControl value={null} onChange={vi.fn()} />)

    expect(screen.queryByText('Workspace Default')).not.toBeInTheDocument()
    for (const label of Object.values(AUTONOMY_LABELS)) {
      expect(optionFor(label)).not.toHaveClass('autonomy-control__option--active')
    }
  })

  it('still highlights an existing override while the workspace level is loading', () => {
    render(<AutonomyControl value="autonomous" onChange={vi.fn()} />)

    expect(optionFor('More autonomous')).toHaveClass('autonomy-control__option--active')
  })
})
