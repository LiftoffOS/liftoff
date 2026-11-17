import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isChunkLoadError, reloadForStaleChunk, registerChunkErrorReload } from './chunkReload'

const reloadMock = vi.fn()

beforeEach(() => {
  reloadMock.mockClear()
  sessionStorage.clear()
  // jsdom's window.location.reload throws "Not implemented"; stub the one method
  // the util touches. Vitest isolates modules per file, so this does not leak.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { reload: reloadMock },
  })
})

describe('isChunkLoadError', () => {
  it('matches the failed-dynamic-import messages across browsers', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://x/AgentsPage-abc.js'))).toBe(true)
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Failed to load module script'))).toBe(true)
  })

  it('matches by error name (webpack-style ChunkLoadError)', () => {
    const err = new Error('boom')
    err.name = 'ChunkLoadError'
    expect(isChunkLoadError(err)).toBe(true)
  })

  it('does not match ordinary render errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('reloadForStaleChunk', () => {
  it('reloads once and records the attempt', () => {
    expect(reloadForStaleChunk()).toBe(true)
    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('chunkReload:lastAttempt')).not.toBeNull()
  })

  it('suppresses a second reload within the guard window', () => {
    expect(reloadForStaleChunk()).toBe(true)
    expect(reloadForStaleChunk()).toBe(false)
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('reloads again once the previous attempt is older than the window', () => {
    // Simulate a prior attempt 11s ago (window is 10s).
    sessionStorage.setItem('chunkReload:lastAttempt', String(Date.now() - 11_000))
    expect(reloadForStaleChunk()).toBe(true)
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })
})

describe('registerChunkErrorReload', () => {
  it('reloads when a vite:preloadError event fires', () => {
    registerChunkErrorReload()
    window.dispatchEvent(new Event('vite:preloadError'))
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })
})
