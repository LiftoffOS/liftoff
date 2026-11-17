// apiBlob: an authenticated GET whose answer is a file.
//
// It sits beside apiFetch and must behave like it where it matters: the same
// auth headers, an error body parsed into the same ApiError with the
// backend's message and code, and the filename read off Content-Disposition,
// `filename*` first.

import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/mocks/server'
import { apiBlob, ApiError, filenameFromContentDisposition } from './api'

describe('filenameFromContentDisposition', () => {
  it('prefers the UTF-8 filename*, decoded', () => {
    expect(filenameFromContentDisposition(
      `attachment; filename="ascii.zip"; filename*=UTF-8''liftoff-%C3%BCn%C3%AFcode.zip`,
    )).toBe('liftoff-ünïcode.zip')
  })

  it('falls back to the plain filename, quoted or bare', () => {
    expect(filenameFromContentDisposition('attachment; filename="export.zip"')).toBe('export.zip')
    expect(filenameFromContentDisposition('attachment; filename=export.zip')).toBe('export.zip')
  })

  it('answers null when there is no name to read', () => {
    expect(filenameFromContentDisposition(null)).toBeNull()
    expect(filenameFromContentDisposition('attachment')).toBeNull()
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull()
  })
})

describe('apiBlob', () => {
  it('returns the bytes and the filename the header names', async () => {
    server.use(
      http.get('*/api/workspace-export', () =>
        new HttpResponse(new Uint8Array([80, 75, 3, 4]), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="x-export-2026-09-18.zip"; filename*=UTF-8''x-export-2026-09-18.zip`,
          },
        }),
      ),
    )

    const { blob, filename } = await apiBlob('/api/workspace-export?tenantId=t1')
    expect(filename).toBe('x-export-2026-09-18.zip')
    expect(blob.size).toBe(4)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]))
  })

  it('surfaces the backend message and code on a 4xx or 5xx, as apiFetch does', async () => {
    for (const [status, code, error] of [
      [409, 'EXPORT_IN_PROGRESS', 'An export of this workspace is already in progress'],
      [413, 'EXPORT_TOO_LARGE', 'The workspace holds more than this export can carry'],
      [429, 'RATE_LIMITED', 'Too many exports; try again later'],
      [503, 'EXPORT_SOURCE_UNAVAILABLE', 'A part of the workspace could not be read; try again shortly'],
    ] as const) {
      server.use(http.get('*/api/workspace-export', () => HttpResponse.json({ error, code }, { status })))
      const err = await apiBlob('/api/workspace-export?tenantId=t1').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(status)
      expect((err as ApiError).code).toBe(code)
      expect((err as ApiError).message).toBe(error)
    }
  })

  it('names a body that is not JSON the same generic way', async () => {
    server.use(http.get('*/api/workspace-export', () => new HttpResponse('nope', { status: 500 })))
    const err = await apiBlob('/api/workspace-export?tenantId=t1').catch((e: unknown) => e)
    expect((err as ApiError).message).toBe('Request failed')
    expect((err as ApiError).status).toBe(500)
  })
})
