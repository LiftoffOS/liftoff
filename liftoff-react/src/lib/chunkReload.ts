// Recovery for stale lazy-loaded chunks after a deploy.
//
// This app auto-deploys on every push to main, and Vite emits content-hashed
// chunk filenames (e.g. `AgentsPage-a1b2c3d4.js`). A tab left open across a
// deploy still holds the OLD chunk map, so the next client-side navigation
// dynamically imports a hashed file the server has already deleted and the
// import 404s. Vite's documented remedy is to listen for `vite:preloadError`
// and reload the page so the browser fetches the fresh index.html and its new
// manifest: https://vite.dev/guide/build.html#load-error-handling
//
// We wrap that reload in a one-shot guard so a reload that cannot recover
// (offline, or a stale-cached HTML shell that still points at the dead chunks)
// can't loop forever — after one attempt inside the window we let the error UI
// show instead. For the reload to be reliable the HTML shell must be served
// with `Cache-Control: no-cache` (see nginx.conf); otherwise the reload can be
// answered from cache with the same stale manifest.

const RELOAD_GUARD_KEY = 'chunkReload:lastAttempt'
// Any stale-chunk failures within this window after a reload share that one
// reload rather than triggering another. Long enough to cover the fresh page's
// load; short enough that the NEXT real deploy still recovers automatically.
const RELOAD_WINDOW_MS = 10_000

/**
 * True when `error` looks like a failed dynamic `import()` — the browser-specific
 * messages Vite/Rollup lazy chunks fail with across Chrome, Firefox and Safari.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false
  const err = error as { name?: unknown; message?: unknown }
  const name = typeof err.name === 'string' ? err.name : ''
  const message = (typeof err.message === 'string' ? err.message : String(error)).toLowerCase()
  return (
    name === 'ChunkLoadError' ||
    // Chrome / Edge
    message.includes('failed to fetch dynamically imported module') ||
    // Firefox
    message.includes('error loading dynamically imported module') ||
    // Safari
    message.includes('importing a module script failed') ||
    message.includes('failed to load module script')
  )
}

/**
 * Reload the page once to recover from a stale-chunk import failure.
 *
 * Returns `true` if a reload was triggered, or `false` if the one-shot guard
 * suppressed it (we already reloaded within the last {@link RELOAD_WINDOW_MS}
 * and it did not help). A `false` return is the caller's signal to fall back to
 * a visible error state rather than leave the user on a blank, reloading page.
 */
export function reloadForStaleChunk(): boolean {
  let last = 0
  try {
    last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0')
  } catch {
    // sessionStorage can throw in private mode / sandboxed iframes; treat the
    // absence of a stored timestamp as "no prior attempt".
  }

  const now = Date.now()
  if (last && now - last < RELOAD_WINDOW_MS) {
    return false
  }

  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now))
  } catch {
    // Non-fatal — worst case a rare double reload rather than none.
  }

  window.location.reload()
  return true
}

/**
 * Register Vite's recommended stale-chunk handler. Call once at startup, before
 * the app renders, so the listener is in place when the first lazy chunk loads.
 */
export function registerChunkErrorReload(): void {
  // `vite:preloadError` fires when the module-preload helper can't fetch a
  // chunk's dependency — the earliest signal that the build is stale.
  window.addEventListener('vite:preloadError', () => {
    reloadForStaleChunk()
  })
}
