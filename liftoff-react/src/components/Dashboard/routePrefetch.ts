// Warm a dashboard route's lazy chunk before the user clicks it, so navigation
// feels instant instead of flashing DashboardLayout's content-area loader.
//
// Each thunk mirrors the dynamic import App.tsx's lazy() uses for that route.
// Vite/Rollup dedupe identical module graphs into ONE chunk per page, so
// calling the thunk here primes exactly the chunk the click will load. import()
// is idempotent — the module cache dedupes repeat calls — so hovering the same
// link many times triggers at most one network fetch. Pure cache-warming: no
// render, no state, no side effect beyond the fetch.
const routePrefetch: Record<string, () => Promise<unknown>> = {
  '/dashboard': () => import('../../pages/Dashboard/HomePage'),
  '/dashboard/agents': () => import('../../pages/Dashboard/AgentsPage'),
  '/dashboard/knowledge': () => import('../../pages/Dashboard/KnowledgePage'),
  '/dashboard/oversight': () => import('../../pages/Dashboard/OversightPage'),
  '/dashboard/review': () => import('../../pages/Dashboard/ReviewQueuePage'),
  '/dashboard/activity': () => import('../../pages/Dashboard/ActivityPage'),
  '/dashboard/insights': () => import('../../pages/Dashboard/InsightsPage'),
  '/dashboard/connections': () => import('../../pages/Dashboard/ConnectionsPage'),
}

/** Best-effort prefetch of a dashboard route's chunk. No-op for unknown paths. */
export function prefetchRoute(path: string): void {
  const thunk = routePrefetch[path]
  if (thunk) thunk().catch(() => { /* prefetch is best-effort; the real nav will surface any load error */ })
}
