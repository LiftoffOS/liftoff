// Tests for SkillsManager — the "Uses" row is the only display. Each skill is
// a pill carrying its own actions, and Edit is the one action that opens
// anything (the instruction editor, below the pills).

import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSkill } from '../../services/internalAgents'
import SkillsManager from './SkillsManager'

const skill = (over: Partial<AgentSkill> = {}): AgentSkill => ({
  id: 'skill-1',
  name: 'Escalate refunds',
  description: 'Route refund requests over $500 to a human',
  instruction: 'When a refund exceeds $500, hand off to the on-call reviewer.',
  ...over,
})

const openMenuFor = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))

describe('SkillsManager', () => {
  it('renders one pill per active skill under a single Uses label', () => {
    const { container } = render(
      <SkillsManager
        skills={[skill(), skill({ id: 'skill-2', name: 'Summarize tickets' })]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Uses')).toHaveLength(1)
    expect(container.querySelectorAll('.skills-manager__chip')).toHaveLength(2)
    expect(screen.getByText('Escalate refunds')).toBeInTheDocument()
    expect(screen.getByText('Summarize tickets')).toBeInTheDocument()
    // No second, card-shaped listing next to the pills: the description is
    // carried by the pill's tooltip and nowhere else.
    screen.getAllByText('Route refund requests over $500 to a human').forEach(el => {
      expect(el).toHaveClass('tooltip-portal')
    })
  })

  it('shows nothing until a pill action menu is opened', () => {
    const { container } = render(<SkillsManager skills={[skill()]} onChange={vi.fn()} />)

    expect(container.querySelector('.action-menu__dropdown')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    openMenuFor('Escalate refunds')

    // The shared ActionMenu owns the dropdown surface, so this matches the
    // teams page menu rather than reimplementing one.
    const menu = container.querySelector('.action-menu__dropdown') as HTMLElement
    expect(menu).toBeInTheDocument()
    expect(within(menu).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(menu).getByRole('button', { name: 'Preserve' })).toBeInTheDocument()
    expect(within(menu).getByRole('button', { name: 'Archive' })).toBeInTheDocument()
  })

  it('offers Allow updates on an already preserved skill', () => {
    render(<SkillsManager skills={[skill({ protected: true })]} onChange={vi.fn()} />)

    openMenuFor('Escalate refunds')
    expect(screen.getByRole('button', { name: 'Allow updates' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preserve' })).not.toBeInTheDocument()
  })

  it('preserving a skill takes ownership without changing the instruction', () => {
    const onChange = vi.fn()
    render(<SkillsManager skills={[skill()]} onChange={onChange} />)

    openMenuFor('Escalate refunds')
    fireEvent.click(screen.getByRole('button', { name: 'Preserve' }))

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        instruction: 'When a refund exceeds $500, hand off to the on-call reviewer.',
        provenance: 'operator',
        protected: true,
      }),
    ])
  })

  it('opens the editor only after Edit, and saves the edited instruction', () => {
    const onChange = vi.fn()
    const { container } = render(<SkillsManager skills={[skill()]} onChange={onChange} />)

    openMenuFor('Escalate refunds')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    // The menu closes and the editor takes its place.
    expect(container.querySelector('.action-menu__dropdown')).not.toBeInTheDocument()
    const textarea = screen.getByRole('textbox', { name: 'Instruction for Escalate refunds' })
    expect(textarea).toHaveValue('When a refund exceeds $500, hand off to the on-call reviewer.')

    fireEvent.change(textarea, { target: { value: 'Hand off every refund to the on-call reviewer.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'skill-1',
        instruction: 'Hand off every refund to the on-call reviewer.',
        provenance: 'operator',
        protected: true,
      }),
    ])
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('discards the draft on Cancel', () => {
    const onChange = vi.fn()
    render(<SkillsManager skills={[skill()]} onChange={onChange} />)

    openMenuFor('Escalate refunds')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Never mind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('archives from the pill menu and keeps the skill behind the archived toggle', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SkillsManager skills={[skill()]} onChange={onChange} />)

    openMenuFor('Escalate refunds')
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ archived: true })])

    rerender(<SkillsManager skills={[skill({ archived: true })]} onChange={onChange} />)
    expect(screen.queryByText('Escalate refunds')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show archived (1)' }))
    expect(screen.getByText('Escalate refunds')).toBeInTheDocument()
    openMenuFor('Escalate refunds')
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('renders nothing when there are no skills', () => {
    const { container } = render(<SkillsManager skills={[]} onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
