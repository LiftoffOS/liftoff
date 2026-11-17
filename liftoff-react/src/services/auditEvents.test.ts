import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const postMock = vi.fn().mockResolvedValue(undefined)

vi.mock('./api', () => ({
  api: {
    post: (...args: unknown[]) => postMock(...args),
  },
}))

import { reportAuditEvent, reportSecurityEvent } from './auditEvents'

describe('reportAuditEvent', () => {
  beforeEach(() => {
    postMock.mockClear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // `reportAuditEvent` calls `void send(...)` which kicks off an async
  // POST. Even with a synchronous mock, the assertion must run AFTER the
  // microtask queue flushes — otherwise the test passes only by virtue of
  // mock-call-recording happening synchronously inside the awaited path,
  // and would break if `send` ever gained a real `await` before the post.
  // `await Promise.resolve()` defers to after the current microtask.
  const flushMicrotasks = () => Promise.resolve()

  it('fires immediately when debounceMs is omitted', async () => {
    reportAuditEvent('activity.details_viewed', {
      resourceId: 'log-1',
      params: { x: 1 },
    })
    await flushMicrotasks()
    expect(postMock).toHaveBeenCalledTimes(1)
    expect(postMock).toHaveBeenCalledWith('/api/audit/activity-events', {
      type: 'activity.details_viewed',
      resourceId: 'log-1',
      params: { x: 1 },
    })
  })

  it('coalesces multiple debounced calls for the same key into one POST', async () => {
    reportAuditEvent('activity.search_performed', { params: { query: 'a' } }, 1500)
    reportAuditEvent('activity.search_performed', { params: { query: 'ab' } }, 1500)
    reportAuditEvent('activity.search_performed', { params: { query: 'abc' } }, 1500)
    expect(postMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1500)
    await flushMicrotasks()
    expect(postMock).toHaveBeenCalledTimes(1)
    expect(postMock).toHaveBeenCalledWith('/api/audit/activity-events', {
      type: 'activity.search_performed',
      params: { query: 'abc' },
    })
  })

  it('keys debounce per (type, resourceId) so unrelated events don\'t cancel each other', async () => {
    reportAuditEvent('activity.details_viewed', { resourceId: 'log-1' }, 800)
    reportAuditEvent('activity.details_viewed', { resourceId: 'log-2' }, 800)
    vi.advanceTimersByTime(800)
    await flushMicrotasks()
    expect(postMock).toHaveBeenCalledTimes(2)
  })

  it('swallows API failures (best-effort)', async () => {
    postMock.mockRejectedValueOnce(new Error('network'))
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    reportAuditEvent('activity.time_range_changed', { params: { preset: '7d' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })
})

describe('reportSecurityEvent', () => {
  beforeEach(() => {
    postMock.mockClear()
  })

  it('POSTs to /api/audit/security-events with type + metadata', async () => {
    await reportSecurityEvent('account.mfa_enrolled', { factor: 'totp' })
    expect(postMock).toHaveBeenCalledWith('/api/audit/security-events', {
      type: 'account.mfa_enrolled',
      metadata: { factor: 'totp' },
    })
  })

  it('omits the metadata key entirely when not provided (matches wire shape)', async () => {
    await reportSecurityEvent('account.password_changed')
    expect(postMock).toHaveBeenCalledTimes(1)
    const body = postMock.mock.calls[0][1] as Record<string, unknown>
    expect(body).toEqual({ type: 'account.password_changed' })
    expect('metadata' in body).toBe(false)
  })

  it('swallows API failures (best-effort)', async () => {
    postMock.mockRejectedValueOnce(new Error('network'))
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await reportSecurityEvent('account.password_changed')
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })
})
