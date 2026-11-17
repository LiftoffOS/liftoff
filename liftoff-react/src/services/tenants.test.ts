import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMock = vi.fn()
const postMock = vi.fn().mockResolvedValue(undefined)

vi.mock('./api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}))

import { getAuditEntries, reportAuditExportCompleted } from './tenants'

describe('tenants service — audit helpers', () => {
  beforeEach(() => {
    getMock.mockReset()
    postMock.mockClear()
  })

  describe('getAuditEntries', () => {
    it('GETs the new unified endpoint with startDate + endDate', async () => {
      getMock.mockResolvedValueOnce({ entries: [], nextCursor: null, hasMore: false })
      await getAuditEntries(
        '11111111-1111-1111-1111-111111111111',
        '2026-05-01T00:00:00.000Z',
        '2026-05-21T00:00:00.000Z',
      )
      expect(getMock).toHaveBeenCalledTimes(1)
      const url = getMock.mock.calls[0][0] as string
      expect(url.startsWith('/api/audit/11111111-1111-1111-1111-111111111111/events?')).toBe(true)
      expect(url).toContain('startDate=2026-05-01T00%3A00%3A00.000Z')
      expect(url).toContain('endDate=2026-05-21T00%3A00%3A00.000Z')
      expect(url).not.toContain('cursor=')
    })

    it('appends cursor when provided', async () => {
      getMock.mockResolvedValueOnce({ entries: [], nextCursor: null, hasMore: false })
      await getAuditEntries(
        'tenant-1',
        '2026-05-01T00:00:00.000Z',
        '2026-05-21T00:00:00.000Z',
        'cursor-abc',
      )
      const url = getMock.mock.calls[0][0] as string
      expect(url).toContain('cursor=cursor-abc')
    })
  })

  describe('reportAuditExportCompleted', () => {
    it('POSTs to /events/export-completed with totalRows', async () => {
      await reportAuditExportCompleted(
        '11111111-1111-1111-1111-111111111111',
        '2026-05-01T00:00:00.000Z',
        '2026-05-21T23:59:59.000Z',
        1847,
      )
      expect(postMock).toHaveBeenCalledTimes(1)
      expect(postMock).toHaveBeenCalledWith(
        '/api/audit/11111111-1111-1111-1111-111111111111/events/export-completed',
        {
          startDate: '2026-05-01T00:00:00.000Z',
          endDate: '2026-05-21T23:59:59.000Z',
          totalRows: 1847,
        },
      )
    })

    it('propagates errors so callers can decide retry policy', async () => {
      postMock.mockRejectedValueOnce(new Error('network'))
      await expect(
        reportAuditExportCompleted('tenant-1', 'a', 'b', 0),
      ).rejects.toThrow('network')
    })

    it('accepts totalRows=0 (empty audit period)', async () => {
      await reportAuditExportCompleted(
        'tenant-1',
        '2026-05-01T00:00:00.000Z',
        '2026-05-02T00:00:00.000Z',
        0,
      )
      const body = postMock.mock.calls[0][1] as { totalRows: number }
      expect(body.totalRows).toBe(0)
    })
  })
})
