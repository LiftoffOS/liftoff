import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), api }))

import { getAutoReload } from './billing'

beforeEach(() => vi.clearAllMocks())

// liftoff-billing passes platform-backend's field names through
// (autoReloadEnabled, amountUsd). Read as AutoReloadSettings directly they
// were undefined, so the saved settings never showed.
describe('getAutoReload', () => {
  it('maps the wire fields onto AutoReloadSettings', async () => {
    api.get.mockResolvedValue({ billingMode: 'pre_pay', autoReloadEnabled: true, thresholdUsd: 1, amountUsd: 5, reloadBalanceUsd: 12 })
    await expect(getAutoReload('t1')).resolves.toEqual({ enabled: true, thresholdUsd: 1, reloadAmountUsd: 5 })
  })

  it('keeps settings that were saved and then disabled', async () => {
    api.get.mockResolvedValue({ autoReloadEnabled: false, thresholdUsd: 10, amountUsd: 20 })
    await expect(getAutoReload('t1')).resolves.toEqual({ enabled: false, thresholdUsd: 10, reloadAmountUsd: 20 })
  })

  it('reads a workspace that never set auto-reload as none', async () => {
    api.get.mockResolvedValue({ autoReloadEnabled: false, thresholdUsd: null, amountUsd: null })
    await expect(getAutoReload('t1')).resolves.toBeNull()
  })
})
