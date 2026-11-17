// Workspace AI service functions — wire-level tests. The load-bearing
// assertion is the PATCH body: this repo has a recorded history of new API
// fields dying in explicit client body builders, so the test pins the exact
// body shape { workspaceAiVendor } on the exact tenant PATCH endpoint.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMock = vi.fn()
const patchMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
  },
}))

import { getWorkspaceAiVendor, getWorkspaceAiVendorCatalog, updateWorkspaceAiVendor } from './tenants'

const TENANT = '44444444-4444-4444-4444-444444444444'

describe('workspace AI service', () => {
  beforeEach(() => {
    getMock.mockReset()
    patchMock.mockReset()
  })

  it('getWorkspaceAiVendor GETs /api/tenants/:id/workspace-ai and unwraps { vendor }', async () => {
    getMock.mockResolvedValueOnce({ vendor: 'qwen' })
    const vendor = await getWorkspaceAiVendor(TENANT)
    expect(getMock).toHaveBeenCalledWith(`/api/tenants/${TENANT}/workspace-ai`)
    expect(vendor).toBe('qwen')
  })

  it('getWorkspaceAiVendorCatalog reads vendorModels and vendorCoding from the same endpoint', async () => {
    getMock.mockResolvedValueOnce({
      vendor: 'qwen',
      vendorModels: { qwen: ['Qwen 3.8 Max'] },
      vendorCoding: { qwen: { tool: 'OpenCode', model: 'Qwen 3.8 Max' } },
    })
    expect(await getWorkspaceAiVendorCatalog(TENANT)).toEqual({
      models: { qwen: ['Qwen 3.8 Max'] },
      coding: { qwen: { tool: 'OpenCode', model: 'Qwen 3.8 Max' } },
    })
    expect(getMock).toHaveBeenCalledWith(`/api/tenants/${TENANT}/workspace-ai`)
  })

  it('getWorkspaceAiVendorCatalog is empty against a backend that does not send the fields yet', async () => {
    getMock.mockResolvedValueOnce({ vendor: 'qwen' })
    expect(await getWorkspaceAiVendorCatalog(TENANT)).toEqual({ models: {}, coding: {} })
  })

  it('updateWorkspaceAiVendor PATCHes /api/tenants/:id with EXACTLY { workspaceAiVendor }', async () => {
    patchMock.mockResolvedValueOnce({ id: TENANT, name: 'Acme' })
    await updateWorkspaceAiVendor(TENANT, 'deepseek')
    expect(patchMock).toHaveBeenCalledTimes(1)
    const [url, body] = patchMock.mock.calls[0]
    expect(url).toBe(`/api/tenants/${TENANT}`)
    expect(body).toEqual({ workspaceAiVendor: 'deepseek' })
  })

  it("passes 'default' through unchanged (Liftoff Managed restore)", async () => {
    patchMock.mockResolvedValueOnce({ id: TENANT, name: 'Acme' })
    await updateWorkspaceAiVendor(TENANT, 'default')
    expect(patchMock.mock.calls[0][1]).toEqual({ workspaceAiVendor: 'default' })
  })
})
