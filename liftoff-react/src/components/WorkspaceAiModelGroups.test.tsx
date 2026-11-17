import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import WorkspaceAiModelGroups from './WorkspaceAiModelGroups'
import type { WorkspaceAiVendorCatalog } from '../services/tenants'

const CATALOG: WorkspaceAiVendorCatalog = {
  models: {
    anthropic: ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'],
    openai: ['GPT-6 Astra', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna'],
    qwen: ['Qwen 3.8 Max', 'Qwen 3.7 Plus'],
  },
  coding: {
    anthropic: { tool: 'Claude Code' },
    qwen: { tool: 'OpenCode', model: 'Qwen 3.8 Max' },
  },
}

function chips(group: 'Models' | 'Coding') {
  const list = screen.queryByRole('list', { name: group })
  return list ? within(list).getAllByRole('listitem').map((li) => li.textContent) : []
}

describe('WorkspaceAiModelGroups', () => {
  it('shows the provider\'s models, Frontier first, and its coding tool', () => {
    render(<WorkspaceAiModelGroups vendor="anthropic" catalog={CATALOG} />)
    expect(chips('Models')).toEqual(['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'])
    expect(chips('Coding')).toEqual(['Claude Code'])
  })

  it('names the model a coding tool codes with where Liftoff picks it', () => {
    render(<WorkspaceAiModelGroups vendor="qwen" catalog={CATALOG} />)
    expect(chips('Coding')).toEqual(['OpenCode', 'Qwen 3.8 Max'])
  })

  it('shows a model that holds two places once', () => {
    render(<WorkspaceAiModelGroups vendor="openai" catalog={CATALOG} />)
    expect(chips('Models')).toEqual(['GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna'])
    expect(chips('Coding')).toEqual([])
  })

  it('shows nothing for Liftoff Managed, an unknown provider or an unread catalog', () => {
    const { container, rerender } = render(<WorkspaceAiModelGroups vendor="default" catalog={CATALOG} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<WorkspaceAiModelGroups vendor="minimax" catalog={CATALOG} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<WorkspaceAiModelGroups vendor="anthropic" catalog={undefined} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<WorkspaceAiModelGroups vendor={undefined} catalog={CATALOG} />)
    expect(container).toBeEmptyDOMElement()
  })
})
