// MSW setup for development mode
// This module exports a function to start the mock service worker

export async function startMockServiceWorker() {
  if (import.meta.env.DEV) {
    const { worker } = await import('./browser')

    // Log the API URL for debugging
    console.log('[MSW] API URL:', import.meta.env.VITE_API_URL || 'http://localhost:8080')

    // Start the worker with options
    await worker.start({
      onUnhandledRequest(request, print) {
        // Ignore static assets, HMR, and browser extensions
        const url = new URL(request.url)
        if (
          url.pathname.startsWith('/@') ||
          url.pathname.startsWith('/node_modules') ||
          url.pathname.startsWith('/src') ||
          url.pathname.match(/\.(js|css|png|jpg|svg|ico|woff|woff2)$/) ||
          url.protocol === 'chrome-extension:'
        ) {
          return
        }
        // Warn about unhandled API requests
        print.warning()
      },
      serviceWorker: {
        url: '/mockServiceWorker.js',
      },
    })

    console.log('[MSW] Mock Service Worker started')
  }
}
