// Tests for AdditionalGuidanceInput — same boundConnectorIds threading and
// attachments behavior as ResponsibilitiesInput. Kept as a separate test for
// parity; this input stamps source 'guidance'.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TeamAttachment } from '../services/internalAgents'

const capturedProps: Array<Record<string, unknown>> = []
vi.mock('./MarkdownTextarea', () => ({
  default: (props: Record<string, unknown>) => {
    capturedProps.push(props)
    return null
  },
}))
const popoverProps: Array<Record<string, unknown>> = []
vi.mock('./FileAttach/FileUploadPopover', () => ({
  default: (props: Record<string, unknown>) => {
    popoverProps.push(props)
    return null
  },
}))

import AdditionalGuidanceInput from './AdditionalGuidanceInput'

const uploadAttachment = (over: Partial<Extract<TeamAttachment, { kind: 'upload' }>> = {}): TeamAttachment => ({
  kind: 'upload',
  name: 'edge-cases.md',
  content: '# Edge cases',
  addedAt: new Date().toISOString(),
  source: 'guidance',
  ...over,
})

describe('AdditionalGuidanceInput', () => {
  it('threads boundConnectorIds through to MarkdownTextarea', () => {
    capturedProps.length = 0
    render(
      <AdditionalGuidanceInput
        value=""
        onChange={() => {}}
        boundConnectorIds={['c-1', 'c-2']}
      />,
    )
    expect(capturedProps[0].boundConnectorIds).toEqual(['c-1', 'c-2'])
  })

  it('defaults boundConnectorIds to empty array when omitted', () => {
    capturedProps.length = 0
    render(<AdditionalGuidanceInput value="" onChange={() => {}} />)
    expect(capturedProps[0].boundConnectorIds).toEqual([])
  })

  it('renders cards only for own-source attachments', () => {
    render(
      <AdditionalGuidanceInput
        value=""
        onChange={() => {}}
        attachments={[
          uploadAttachment({ name: 'mine.md', source: 'guidance' }),
          uploadAttachment({ name: 'other.md', source: 'responsibilities' }),
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
    const existing = uploadAttachment({ name: 'other.md', source: 'responsibilities' })
    render(
      <AdditionalGuidanceInput
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
        source: 'guidance',
      },
    ])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes an attachment from the full list on card remove', () => {
    const onAttachmentsChange = vi.fn()
    const mine = uploadAttachment({ name: 'mine.md', source: 'guidance' })
    const other = uploadAttachment({ name: 'other.md', source: 'responsibilities' })
    render(
      <AdditionalGuidanceInput
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
