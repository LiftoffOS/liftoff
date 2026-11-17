// WORKSPACE_AI_OPTIONS — the dropdown's contents and ORDER are product
// decisions: Liftoff Managed first, then the mainstream providers
// (Anthropic, OpenAI, Google, Grok), then the OpenRouter-served open-weights
// vendors alphabetically (DeepSeek, GLM, Kimi, Qwen). This pins both so a
// future edit cannot silently reorder or drop a vendor.

import { describe, it, expect } from 'vitest'

import {
  WORKSPACE_AI_OPTIONS,
  WORKSPACE_DEFAULT_BADGE,
  buildTeamAiProviderOptions,
} from './workspaceAi'

describe('WORKSPACE_AI_OPTIONS', () => {
  it('has the exact decided order and labels', () => {
    expect(WORKSPACE_AI_OPTIONS).toEqual([
      { value: 'default', label: 'Liftoff Managed', badge: 'Recommended' },
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'google', label: 'Google' },
      { value: 'grok', label: 'Grok' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'glm', label: 'GLM' },
      { value: 'kimi', label: 'Kimi' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'qwen', label: 'Qwen' },
      { value: 'xiaomi', label: 'Xiaomi' },
    ])
  })

  it('keeps the open-weights group alphabetical after the mainstream group', () => {
    // Sliced by VALUE, not by a hardcoded index. The old `slice(4)` encoded
    // "the mainstream group is exactly four rows", which silently became false
    // the moment Grok joined it and turned a real ordering guarantee into a
    // failing assertion about the wrong rows.
    const MAINSTREAM = ['default', 'anthropic', 'openai', 'google', 'grok']
    const openWeights = WORKSPACE_AI_OPTIONS
      .filter((o) => !MAINSTREAM.includes(o.value))
      .map((o) => o.label)
    expect(openWeights).toEqual([...openWeights].sort())
    // And the mainstream group really is the leading run, so the two groups
    // cannot interleave without this failing.
    expect(WORKSPACE_AI_OPTIONS.slice(0, MAINSTREAM.length).map((o) => o.value)).toEqual(MAINSTREAM)
  })
})

describe('buildTeamAiProviderOptions', () => {
  // Inherit is not an extra row duplicating a vendor already in the list.
  it('adds no extra row and preserves the workspace order', () => {
    const options = buildTeamAiProviderOptions('anthropic')
    expect(options).toHaveLength(WORKSPACE_AI_OPTIONS.length)
    expect(options.map((o) => o.value)).toEqual(WORKSPACE_AI_OPTIONS.map((o) => o.value))
  })

  it('badges exactly the vendor the workspace is set to', () => {
    const options = buildTeamAiProviderOptions('anthropic')
    const badged = options.filter((o) => o.badge === WORKSPACE_DEFAULT_BADGE)
    expect(badged).toHaveLength(1)
    expect(badged[0].value).toBe('anthropic')
  })

  it("replaces 'Recommended' only on the row the two would share", () => {
    // Workspace elsewhere: Liftoff Managed keeps its own badge.
    const away = buildTeamAiProviderOptions('anthropic')
    expect(away.find((o) => o.value === 'default')?.badge).toBe('Recommended')

    // Workspace on Liftoff Managed: the inherited marker wins that row.
    const onDefault = buildTeamAiProviderOptions('default')
    expect(onDefault.find((o) => o.value === 'default')?.badge).toBe(WORKSPACE_DEFAULT_BADGE)
    expect(onDefault.filter((o) => o.badge === 'Recommended')).toHaveLength(0)
  })

  it('badges nothing while the workspace vendor is still loading', () => {
    const options = buildTeamAiProviderOptions(undefined)
    expect(options.filter((o) => o.badge === WORKSPACE_DEFAULT_BADGE)).toHaveLength(0)
    expect(options).toEqual(WORKSPACE_AI_OPTIONS)
  })

  it('does not mutate the shared workspace option list', () => {
    buildTeamAiProviderOptions('default')
    expect(WORKSPACE_AI_OPTIONS.find((o) => o.value === 'default')?.badge).toBe('Recommended')
  })
})
