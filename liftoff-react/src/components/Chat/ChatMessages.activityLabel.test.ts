import { describe, it, expect } from 'vitest'
import { activityLabel, NEUTRAL_LABEL } from './activityLabel'

// The activity line is the one place a tool name could reach a person, and it
// did: the label used to be derived from the name, so the Chief AI Officer's
// `team__get_config` printed as "Using Get_config". The phrase is authored in
// platform-backend now and arrives on the frame; this renders it and never
// builds one out of a name.

describe('activityLabel', () => {
  it('shows the phrase the backend authored, whatever the tool is called', () => {
    expect(activityLabel('team__get_config', 'Reading the agent')).toBe('Reading the agent')
    expect(activityLabel('anything_at_all', 'Searching the knowledge base')).toBe('Searching the knowledge base')
  })

  it('never shows a tool name, or anything derived from one', () => {
    const names = [
      'team__get_config',
      'knowledge_search',
      'memory_retrieve',
      'connectors__list_available',
      'workforce_plan__draft',
      'get_recent_files',
      'a_tool_nobody_authored',
      'mcp__github-7d07a896__get_file_contents',
    ]
    for (const name of names) {
      const label = activityLabel(name)
      expect(label).not.toContain('_')
      // The underscore check alone would pass on "get config", so assert the
      // label is not the name with its separators swapped out either.
      expect(label.toLowerCase()).not.toBe(name.replace(/_+/g, ' '))
      expect(label.toLowerCase()).not.toContain(name.toLowerCase())
    }
  })

  it('holds no phrases of its own, for any tool, however well known', () => {
    // No map here on purpose: both services that write these frames author the
    // phrase from one shared map, and a copy in the browser would be free to
    // drift from it. A frame with no label is a service mid-deploy, and the
    // answer to that is a phrase that says nothing.
    expect(activityLabel('workforce_plan__draft')).toBe(NEUTRAL_LABEL)
    expect(activityLabel('team__get_config')).toBe(NEUTRAL_LABEL)
    expect(activityLabel('memory_retrieve')).toBe(NEUTRAL_LABEL)
    expect(activityLabel('get_recent_files')).toBe(NEUTRAL_LABEL)
  })

  it('treats an empty or blank label as no label', () => {
    expect(activityLabel('get_recent_files', '')).toBe(NEUTRAL_LABEL)
    expect(activityLabel('get_recent_files', '   ')).toBe(NEUTRAL_LABEL)
    expect(activityLabel('get_recent_files', null)).toBe(NEUTRAL_LABEL)
    expect(activityLabel('get_recent_files', undefined)).toBe(NEUTRAL_LABEL)
  })
})
