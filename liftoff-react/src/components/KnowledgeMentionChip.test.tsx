// Tests for KnowledgeMentionChip — the React NodeView used by the MarkdownTextarea
// editor to render [[knowledge:...]] chips with a live broken state when the
// item is missing or its connector is no longer bound.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  KnowledgeMentionChip,
} from './KnowledgeMentionChip'
import { KnowledgeChipContext, type ChipContextValue } from './knowledgeChipContext'

function makeProps(id: string, label: string) {
  // Minimal NodeViewProps stand-in — we only consume `node.attrs`.
  return {
    node: { attrs: { id, label } },
  } as unknown as Parameters<typeof KnowledgeMentionChip>[0]
}

function ctxWith(overrides: Partial<ChipContextValue> = {}): ChipContextValue {
  return {
    availableItemIds: new Set(['k1']),
    boundConnectorIds: new Set(['c1']),
    itemConnectorMap: new Map([['k1', 'c1']]),
    ...overrides,
  }
}

describe('KnowledgeMentionChip', () => {
  it('renders normal chip when item exists and connector is bound', () => {
    render(
      <KnowledgeChipContext.Provider value={ctxWith()}>
        <KnowledgeMentionChip {...makeProps('k1', 'Article 1')} />
      </KnowledgeChipContext.Provider>,
    )
    const chip = screen.getByText('Article 1')
    expect(chip.className).toContain('knowledge-chip')
    expect(chip.className).not.toContain('knowledge-chip--broken')
  })

  it('renders broken state with "Knowledge item deleted" when id not in availableItemIds', () => {
    render(
      <KnowledgeChipContext.Provider value={ctxWith({ availableItemIds: new Set() })}>
        <KnowledgeMentionChip {...makeProps('k1', 'Gone')} />
      </KnowledgeChipContext.Provider>,
    )
    expect(screen.getByText('Gone').className).toContain('knowledge-chip--broken')
  })

  it('renders broken state when connector is not bound', () => {
    render(
      <KnowledgeChipContext.Provider
        value={ctxWith({ boundConnectorIds: new Set(['cZ']) })}
      >
        <KnowledgeMentionChip {...makeProps('k1', 'Orphan')} />
      </KnowledgeChipContext.Provider>,
    )
    expect(screen.getByText('Orphan').className).toContain('knowledge-chip--broken')
  })

  it('renders normal chip when connectorId is null (manual URL import)', () => {
    render(
      <KnowledgeChipContext.Provider
        value={ctxWith({
          itemConnectorMap: new Map([['k1', null]]),
          boundConnectorIds: new Set(),
        })}
      >
        <KnowledgeMentionChip {...makeProps('k1', 'Manual')} />
      </KnowledgeChipContext.Provider>,
    )
    const chip = screen.getByText('Manual')
    expect(chip.className).not.toContain('knowledge-chip--broken')
  })

  it('sets native title attribute on broken chip (inline-safe; React Tooltip would emit <div> inside <p> and break the editor)', () => {
    render(
      <KnowledgeChipContext.Provider value={ctxWith({ availableItemIds: new Set() })}>
        <KnowledgeMentionChip {...makeProps('k1', 'Gone')} />
      </KnowledgeChipContext.Provider>,
    )
    expect(screen.getByText('Gone').getAttribute('title')).toBe('Knowledge item deleted')
  })

  it('sets title="Connector removed" when connector is unbound', () => {
    render(
      <KnowledgeChipContext.Provider value={ctxWith({ boundConnectorIds: new Set(['cZ']) })}>
        <KnowledgeMentionChip {...makeProps('k1', 'Orphan')} />
      </KnowledgeChipContext.Provider>,
    )
    expect(screen.getByText('Orphan').getAttribute('title')).toBe('Connector removed')
  })

  it('omits title attribute on a healthy chip', () => {
    render(
      <KnowledgeChipContext.Provider value={ctxWith()}>
        <KnowledgeMentionChip {...makeProps('k1', 'OK')} />
      </KnowledgeChipContext.Provider>,
    )
    expect(screen.getByText('OK').getAttribute('title')).toBeNull()
  })
})
