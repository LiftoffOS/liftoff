// The workspace-ai MSW handler. Without it, mock mode leaves the workspace
// vendor unresolved, so the per-AI-team AI Provider Override card can never
// badge its inherited row and the inherit path cannot be exercised at all.
// These run against the real handler list via the shared MSW server.

import { describe, it, expect } from 'vitest'
import { getWorkspaceAiVendor, getWorkspaceAiVendorCatalog, updateWorkspaceAiVendor } from '../../services/tenants'
import { buildTeamAiProviderOptions, WORKSPACE_DEFAULT_BADGE } from '../../constants/workspaceAi'

const TENANT = 'tenant-workspace-ai-mock'

describe('workspace-ai mock handler', () => {
  it('serves a vendor for GET /api/tenants/:id/workspace-ai', async () => {
    expect(await getWorkspaceAiVendor(TENANT)).toBe('anthropic')
  })

  // Seeding to 'default' would put the badge on Liftoff Managed and hide the
  // case that matters: inherit and Liftoff Managed being two different rows.
  it('seeds a non-default vendor so the two states stay distinguishable', async () => {
    const vendor = await getWorkspaceAiVendor(TENANT)
    expect(vendor).not.toBe('default')

    const options = buildTeamAiProviderOptions(vendor)
    const badged = options.filter(o => o.badge === WORKSPACE_DEFAULT_BADGE)
    expect(badged).toHaveLength(1)
    expect(badged[0].value).toBe(vendor)
    // Liftoff Managed remains a separately selectable pin.
    expect(options.find(o => o.value === 'default')?.badge).toBe('Recommended')
  })

  it('serves models and a coding tool for every named provider, and neither for Liftoff Managed', async () => {
    const { models, coding } = await getWorkspaceAiVendorCatalog(TENANT)
    expect(models.default).toBeUndefined()
    expect(coding.default).toBeUndefined()
    for (const vendor of ['anthropic', 'openai', 'google', 'grok', 'deepseek', 'glm', 'kimi', 'minimax', 'qwen'] as const) {
      expect(models[vendor]?.length, vendor).toBeGreaterThan(0)
      expect(coding[vendor]?.tool, vendor).toBeTruthy()
    }
  })

  it('reflects a Settings write back to the override card', async () => {
    await updateWorkspaceAiVendor(TENANT, 'qwen')
    expect(await getWorkspaceAiVendor(TENANT)).toBe('qwen')
  })
})
