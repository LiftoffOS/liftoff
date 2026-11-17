// Tests for ResponsibilitiesInput — verifies that boundConnectorIds is
// threaded through to MarkdownTextarea so the [[ autocomplete and
// broken-chip rendering inside the editor see the agent's current
// connector binding state, and that attachments are lifted state:
// imports never touch the textarea value, cards render only own-source
// attachments, and add/remove flow through onAttachmentsChange.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TeamAttachment } from '../services/internalAgents'

// Capture the props MarkdownTextarea receives so we can assert on them.
const capturedProps: Array<Record<string, unknown>> = []
vi.mock('./MarkdownTextarea', () => ({
  default: (props: Record<string, unknown>) => {
    capturedProps.push(props)
    return null
  },
}))
// Capture the props FileUploadPopover receives so tests can drive onAttach.
const popoverProps: Array<Record<string, unknown>> = []
vi.mock('./FileAttach/FileUploadPopover', () => ({
  default: (props: Record<string, unknown>) => {
    popoverProps.push(props)
    return null
  },
}))

import ResponsibilitiesInput from './ResponsibilitiesInput'

const uploadAttachment = (over: Partial<Extract<TeamAttachment, { kind: 'upload' }>> = {}): TeamAttachment => ({
  kind: 'upload',
  name: 'skills.md',
  content: '# Skills',
  addedAt: new Date().toISOString(),
  source: 'responsibilities',
  ...over,
})

describe('ResponsibilitiesInput', () => {
  it('threads boundConnectorIds through to MarkdownTextarea', () => {
    capturedProps.length = 0
    render(
      <ResponsibilitiesInput
        value=""
        onChange={() => {}}
        knowledgeItems={[]}
        agentItems={[]}
        boundConnectorIds={['c-1', 'c-2']}
      />,
    )
    expect(capturedProps[0].boundConnectorIds).toEqual(['c-1', 'c-2'])
  })

  it('defaults boundConnectorIds to empty array when omitted', () => {
    capturedProps.length = 0
    render(<ResponsibilitiesInput value="" onChange={() => {}} />)
    expect(capturedProps[0].boundConnectorIds).toEqual([])
  })

  it('renders cards only for own-source attachments', () => {
    render(
      <ResponsibilitiesInput
        value=""
        onChange={() => {}}
        attachments={[
          uploadAttachment({ name: 'mine.md', source: 'responsibilities' }),
          uploadAttachment({ name: 'other.md', source: 'guidance' }),
        ]}
        onAttachmentsChange={() => {}}
      />,
    )
    expect(screen.getByText('mine.md')).toBeInTheDocument()
    expect(screen.queryByText('other.md')).not.toBeInTheDocument()
  })

  it('stamps its source on attached items and never touches the textarea value', () => {
    popoverProps.length = 0
    const onChange = vi.fn()
    const onAttachmentsChange = vi.fn()
    const existing = uploadAttachment({ name: 'other.md', source: 'guidance' })
    render(
      <ResponsibilitiesInput
        value=""
        onChange={onChange}
        attachments={[existing]}
        onAttachmentsChange={onAttachmentsChange}
      />,
    )
    const onAttach = popoverProps[0].onAttach as (items: Record<string, unknown>[]) => void
    onAttach([{ kind: 'upload', name: 'new.md', content: 'x', addedAt: '2026-01-01T00:00:00.000Z' }])
    expect(onAttachmentsChange).toHaveBeenCalledWith([
      existing,
      {
        kind: 'upload',
        name: 'new.md',
        content: 'x',
        addedAt: '2026-01-01T00:00:00.000Z',
        source: 'responsibilities',
      },
    ])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes an attachment from the full list on card remove', () => {
    const onAttachmentsChange = vi.fn()
    const mine = uploadAttachment({ name: 'mine.md', source: 'responsibilities' })
    const other = uploadAttachment({ name: 'other.md', source: 'guidance' })
    render(
      <ResponsibilitiesInput
        value=""
        onChange={() => {}}
        attachments={[mine, other]}
        onAttachmentsChange={onAttachmentsChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }))
    expect(onAttachmentsChange).toHaveBeenCalledWith([other])
  })
})
