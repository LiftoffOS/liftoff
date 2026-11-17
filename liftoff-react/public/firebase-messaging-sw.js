/* Background handler for browser notifications.
 *
 * Named firebase-messaging-sw.js because that is the filename the Firebase
 * Messaging SDK looks for by convention, but it deliberately loads no Firebase
 * code. The documented alternative is importScripts() of two compat bundles
 * from gstatic, which would add a runtime CDN dependency on every push and a
 * second copy of the Firebase config living out here in public/. Neither buys
 * anything: a push message arrives as ordinary Web Push, and everything below
 * is the standard Push API.
 *
 * Served with `expires -1` (see nginx.conf). A service worker cached
 * `immutable` for a year cannot be updated, and every .js otherwise matches the
 * one-year rule.
 */

// Take over immediately rather than waiting for every tab to close. A stale
// worker here means notifications keep being handled by whatever shipped last.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

const FALLBACK_TITLE = 'Liftoff'
const FALLBACK_ICON = '/android-chrome-192x192.png'
const FALLBACK_BADGE = '/favicon-96x96.png'

self.addEventListener('push', (event) => {
  // Chrome subscribes us userVisibleOnly, so every push MUST end in a visible
  // notification. Returning without one makes Chrome post its own "This site
  // has been updated in the background" message instead, and a site that keeps
  // doing it loses the permission altogether. So a push we cannot read still
  // shows something honest rather than nothing.
  let payload = {}
  if (event.data) {
    try {
      payload = event.data.json()
    } catch {
      payload = {}
    }
  }

  const notification = payload.notification || {}
  const data = payload.data || {}
  const fcmOptions = payload.fcmOptions || payload.fcm_options || {}
  const link = data.link || fcmOptions.link || '/'

  event.waitUntil(
    self.registration.showNotification(notification.title || FALLBACK_TITLE, {
      body: notification.body || '',
      // Collapse key. Several replies in one thread replace each other rather
      // than stacking, so coming back to a conversation does not mean clearing
      // five notifications about it.
      tag: notification.tag || undefined,
      // Without this, a replacement is SILENT. The tag above is what makes
      // three replies in one conversation collapse into one notification, but
      // the spec says a same-tag replacement must not alert again unless
      // renotify is set — so the second and every later reply in a thread
      // updated the notification in place with no banner and no sound, which
      // is indistinguishable from never having been sent.
      renotify: Boolean(notification.tag),
      icon: notification.icon || FALLBACK_ICON,
      badge: notification.badge || FALLBACK_BADGE,
      // Carried onto the notification so notificationclick can read it: the
      // push payload is long gone by then.
      data: { link },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const link = (event.notification.data && event.notification.data.link) || '/'

  event.waitUntil(
    (async () => {
      const target = new URL(link, self.location.origin)

      // Never navigate somewhere else's origin on the strength of a payload.
      if (target.origin !== self.location.origin) return

      // Focus a tab that is already open rather than opening a second one.
      // Without this, someone who works with Liftoff open all day accumulates a
      // new window per notification.
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      for (const client of clientList) {
        if (new URL(client.url).origin !== target.origin) continue
        try {
          await client.focus()
          // Focus alone would leave them on whatever page they were last on,
          // not the conversation the notification was about.
          await client.navigate(target.href)
          return
        } catch {
          // navigate() rejects on a client this worker does not control (a
          // hard-reloaded tab stays uncontrolled for the life of the SPA), and
          // some browsers do not implement it on WindowClient at all. Every
          // failure here ended the handler silently: the tab got focus, kept
          // whatever page it was on, and the click looked like it did nothing.
          // A new window on the right page beats a focused tab on the wrong
          // one, so fall through to openWindow.
          break
        }
      }

      await self.clients.openWindow(target.href)
    })(),
  )
})
