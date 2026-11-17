import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
vi.mock('./api', () => ({ api: { get: (...args: unknown[]) => get(...args) } }))

const { getMediaUrl, peekMediaUrl, refreshMediaUrl, _resetMediaUrlCache } = await import('./mediaUrl')

const TENANT = 'tenant-1'
const MEDIA = 'media-1'

beforeEach(() => {
  _resetMediaUrlCache()
  get.mockReset()
  let n = 0
  // A real mint signs against `Date.now() + 1h`, so every call returns a
  // DIFFERENT url. That is the whole reason this cache exists, so the fake has
  // to behave the same way.
  get.mockImplementation(async () => ({ downloadUrl: `https://signed/${++n}`, mimeType: 'image/png' }))
})

describe('one URL per object, per session', () => {
  // The behaviour the person actually noticed: an image they were already
  // looking at in the composer re-downloaded when the message sent, because
  // the bubble minted a second URL and a different URL is a different resource
  // to an HTTP cache.
  it('gives the second reader the first reader’s URL', async () => {
    const first = await getMediaUrl(TENANT, MEDIA)
    const second = await getMediaUrl(TENANT, MEDIA)
    expect(second?.downloadUrl).toBe(first?.downloadUrl)
    expect(get).toHaveBeenCalledTimes(1)
  })

  // Four cards mounting together must make one request, not four. Waiting for
  // the first response before de-duplicating would help only after the moment
  // it is needed.
  it('collapses simultaneous requests into one', async () => {
    const all = await Promise.all([
      getMediaUrl(TENANT, MEDIA),
      getMediaUrl(TENANT, MEDIA),
      getMediaUrl(TENANT, MEDIA),
    ])
    expect(new Set(all.map(r => r?.downloadUrl)).size).toBe(1)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('lets a component read the cache without a request', async () => {
    expect(peekMediaUrl(TENANT, MEDIA)).toBeNull()
    await getMediaUrl(TENANT, MEDIA)
    expect(peekMediaUrl(TENANT, MEDIA)?.downloadUrl).toBe('https://signed/1')
    expect(get).toHaveBeenCalledTimes(1)
  })

  // The download route is membership-checked server-side, so a stale key would
  // fail rather than leak — but failing is not the behaviour we want either.
  it('does not reuse a URL across workspaces', async () => {
    const a = await getMediaUrl(TENANT, MEDIA)
    const b = await getMediaUrl('tenant-2', MEDIA)
    expect(b?.downloadUrl).not.toBe(a?.downloadUrl)
    expect(get).toHaveBeenCalledTimes(2)
  })
})

describe('the cases the cache must not paper over', () => {
  // If a refresh returned the cached value, the retry after a failed load would
  // be a no-op and the image would stay broken forever.
  it('mints a new URL on refresh', async () => {
    const first = await getMediaUrl(TENANT, MEDIA)
    const fresh = await refreshMediaUrl(TENANT, MEDIA)
    expect(fresh?.downloadUrl).not.toBe(first?.downloadUrl)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure', async () => {
    get.mockRejectedValueOnce(new Error('nope'))
    expect(await getMediaUrl(TENANT, MEDIA)).toBeNull()
    // The next reader must be free to try again rather than inherit the null.
    expect((await getMediaUrl(TENANT, MEDIA))?.downloadUrl).toBe('https://signed/1')
  })

  it('asks for nothing before the workspace is known', async () => {
    expect(await getMediaUrl(undefined, MEDIA)).toBeNull()
    expect(peekMediaUrl(undefined, MEDIA)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  // A cache is a performance device and must never be the reason an image
  // fails, so an entry stops being handed out well before the signature dies.
  it('stops serving an entry before the signature expires', async () => {
    vi.useFakeTimers()
    try {
      await getMediaUrl(TENANT, MEDIA)
      vi.advanceTimersByTime(51 * 60 * 1000)
      expect(peekMediaUrl(TENANT, MEDIA)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
