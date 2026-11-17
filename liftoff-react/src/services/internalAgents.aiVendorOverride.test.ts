// Per-AI-team AI provider override — wire-level tests. The load-bearing
// assertion is that `aiVendorOverride: null` SURVIVES into the PUT body:
// null is how an agent is returned to the workspace choice, so a body
// builder that strips nullish values would silently make "revert to inherit"
// a no-op. Mirrors tenants.workspaceAi.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const putMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: (...args: unknown[]) => putMock(...args),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}))

// internalAgents pulls firebase auth at module scope for its streaming helpers.
vi.mock('../config/firebase', () => ({ auth: { currentUser: null } }))

import { updateInternalAgent } from './internalAgents'

const AGENT = 'internal-agent-sales-001'
const TENANT = '44444444-4444-4444-4444-444444444444'

describe('updateInternalAgent aiVendorOverride', () => {
  beforeEach(() => {
    putMock.mockReset()
  })

  it('PUTs the vendor verbatim on the internal-agents endpoint', async () => {
    putMock.mockResolvedValueOnce({ id: AGENT })
    await updateInternalAgent(AGENT, TENANT, { aiVendorOverride: 'anthropic' })
    expect(putMock).toHaveBeenCalledTimes(1)
    const [url, body] = putMock.mock.calls[0]
    expect(url).toBe(`/api/internal-agents/${AGENT}?tenantId=${TENANT}`)
    expect(body).toEqual({ aiVendorOverride: 'anthropic' })
  })

  it('keeps null in the body so reverting to the workspace choice persists', async () => {
    putMock.mockResolvedValueOnce({ id: AGENT })
    await updateInternalAgent(AGENT, TENANT, { aiVendorOverride: null })
    const [, body] = putMock.mock.calls[0]
    expect(body).toHaveProperty('aiVendorOverride', null)
    expect(Object.keys(body as object)).toContain('aiVendorOverride')
  })

  it("does not collapse 'default' (Liftoff Managed) onto null (inherit)", async () => {
    putMock.mockResolvedValueOnce({ id: AGENT })
    await updateInternalAgent(AGENT, TENANT, { aiVendorOverride: 'default' })
    expect(putMock.mock.calls[0][1]).toEqual({ aiVendorOverride: 'default' })
  })
})
