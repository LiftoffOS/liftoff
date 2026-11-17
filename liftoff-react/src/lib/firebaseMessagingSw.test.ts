// The push service worker's display contract.
//
// This file ships from public/ and is never imported by the app, so nothing
// type-checked it and nothing tested it. It is also the last step before a
// person sees a notification: everything upstream can be provably correct and
// still produce silence if this handler does not call showNotification.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const SOURCE = readFileSync(resolve(process.cwd(), 'public/firebase-messaging-sw.js'), 'utf8')

type Listener = (event: unknown) => void

function loadWorker() {
  const listeners = new Map<string, Listener>()
  const showNotification = vi.fn().mockResolvedValue(undefined)
  const clients = {
    claim: vi.fn(),
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn().mockResolvedValue(undefined),
  }

  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: { showNotification },
    clients,
    location: { origin: 'https://example.com' },
    skipWaiting: vi.fn(),
  }

  new Function('self', SOURCE)(self)
  return { listeners, showNotification, clients }
}

function pushEvent(body: string | null) {
  return {
    data: body === null ? null : { json: () => JSON.parse(body) },
    waitUntil: (p: unknown) => p,
  }
}

let worker: ReturnType<typeof loadWorker>

beforeEach(() => {
  worker = loadWorker()
})

const FCM_PAYLOAD = JSON.stringify({
  notification: {
    title: 'Atlas',
    body: 'Four contracts expire before December.',
    tag: 'task_update:thread-1',
    icon: '/android-chrome-192x192.png',
    badge: '/favicon-96x96.png',
  },
  data: { link: 'https://example.com/notification/abc' },
  fcmOptions: { link: 'https://example.com/notification/abc' },
})

describe('push handler', () => {
  it('shows what the payload says', () => {
    worker.listeners.get('push')!(pushEvent(FCM_PAYLOAD))

    expect(worker.showNotification).toHaveBeenCalledTimes(1)
    const [title, options] = worker.showNotification.mock.calls[0]
    expect(title).toBe('Atlas')
    expect(options.body).toBe('Four contracts expire before December.')
    expect(options.tag).toBe('task_update:thread-1')
  })

  // The tag collapses replies in one conversation into a single notification.
  // Without renotify, the spec makes that replacement SILENT — so the second
  // and every later reply in a thread updated the notification in place with no
  // banner and no sound, which looks exactly like never having been sent.
  it('re-alerts when a notification collapses onto an earlier one', () => {
    worker.listeners.get('push')!(pushEvent(FCM_PAYLOAD))
    expect(worker.showNotification.mock.calls[0][1].renotify).toBe(true)
  })

  // renotify without a tag is invalid and throws a TypeError in Chrome, which
  // would turn every untagged notification into no notification at all.
  it('does not set renotify when there is nothing to collapse onto', () => {
    worker.listeners.get('push')!(pushEvent(JSON.stringify({ notification: { title: 'Liftoff' } })))
    const options = worker.showNotification.mock.calls[0][1]
    expect(options.tag).toBeUndefined()
    expect(options.renotify).toBe(false)
  })

  // Chrome subscribes userVisibleOnly: a push that ends without a notification
  // makes Chrome post its own "site updated in the background" message, and a
  // site that keeps doing it loses the permission.
  it.each([
    ['a payload that is not JSON', '{not json'],
    ['a push with no data at all', null],
  ])('still shows something for %s', (_label, body) => {
    worker.listeners.get('push')!(pushEvent(body))
    expect(worker.showNotification).toHaveBeenCalledTimes(1)
    expect(worker.showNotification.mock.calls[0][0]).toBe('Liftoff')
  })

  // The push payload is gone by the time anyone clicks, so the destination has
  // to travel on the notification itself.
  it('carries the link onto the notification', () => {
    worker.listeners.get('push')!(pushEvent(FCM_PAYLOAD))
    expect(worker.showNotification.mock.calls[0][1].data).toEqual({
      link: 'https://example.com/notification/abc',
    })
  })
})

// The click half of the contract. The handler has exactly one job: land the
// person on data.link. Without a fallback in the focus branch it fails when a
// tab is already open: a client whose navigate() rejects (an uncontrolled tab)
// or does not exist eats the click after focusing, and the person is left
// staring at whatever page that tab already showed.
describe('notificationclick handler', () => {
  const LINK = 'https://example.com/notification/abc'

  function clickEvent(link: string | null) {
    let settled: unknown = null
    return {
      event: {
        notification: { close: vi.fn(), data: link === null ? null : { link } },
        waitUntil: (p: unknown) => { settled = p },
      },
      done: () => settled as Promise<void>,
    }
  }

  function windowClient(overrides: Record<string, unknown> = {}) {
    return {
      url: 'https://example.com/dashboard',
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  it('opens the destination when no tab is open', async () => {
    const { event, done } = clickEvent(LINK)
    worker.listeners.get('notificationclick')!(event)
    await done()
    expect(worker.clients.openWindow).toHaveBeenCalledWith(LINK)
  })

  it('focuses an open tab and navigates it to the destination', async () => {
    const client = windowClient()
    worker.clients.matchAll.mockResolvedValue([client])
    const { event, done } = clickEvent(LINK)
    worker.listeners.get('notificationclick')!(event)
    await done()
    expect(client.focus).toHaveBeenCalled()
    expect(client.navigate).toHaveBeenCalledWith(LINK)
    expect(worker.clients.openWindow).not.toHaveBeenCalled()
  })

  // An uncontrolled client (a hard-reloaded tab) rejects navigate(). The click
  // must still land somewhere: a new window on the right page.
  it('falls back to a new window when the focused tab cannot be navigated', async () => {
    const client = windowClient({
      navigate: vi.fn().mockRejectedValue(new TypeError('not controlled')),
    })
    worker.clients.matchAll.mockResolvedValue([client])
    const { event, done } = clickEvent(LINK)
    worker.listeners.get('notificationclick')!(event)
    await done()
    expect(worker.clients.openWindow).toHaveBeenCalledWith(LINK)
  })

  // Browsers without WindowClient.navigate make the call throw synchronously.
  // Same contract: the click still lands.
  it('falls back to a new window when the client has no navigate at all', async () => {
    const client = windowClient({ navigate: undefined })
    worker.clients.matchAll.mockResolvedValue([client])
    const { event, done } = clickEvent(LINK)
    worker.listeners.get('notificationclick')!(event)
    await done()
    expect(worker.clients.openWindow).toHaveBeenCalledWith(LINK)
  })

  // The origin guard survives the fallback: a payload naming another origin
  // must neither navigate a tab nor open a window.
  it('never opens somebody else\'s origin', async () => {
    const client = windowClient()
    worker.clients.matchAll.mockResolvedValue([client])
    const { event, done } = clickEvent('https://evil.example/phish')
    worker.listeners.get('notificationclick')!(event)
    await done()
    expect(client.navigate).not.toHaveBeenCalled()
    expect(worker.clients.openWindow).not.toHaveBeenCalled()
  })
})
