import '@testing-library/jest-dom/vitest'
import { vi, afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './mocks/server'

// Mock Firebase to prevent initializeApp from running in tests
vi.mock('../config/firebase', () => ({
  app: {},
  auth: { currentUser: null, onAuthStateChanged: vi.fn(), authStateReady: () => Promise.resolve() },
  googleProvider: {},
}))

// jsdom does not implement IntersectionObserver, so anything that constructs
// one on mount (useScrollAnimation, the infinite-scroll sentinels) throws here
// while working perfectly in a real browser. That is an environment gap, not a
// component bug, so the stub lives with the environment rather than in each
// component's test. It never reports an intersection: nothing under test scrolls,
// and the reveal it gates is opacity in CSS, which jsdom does not apply anyway.
// Assigned rather than vi.stubGlobal so a test file's vi.unstubAllGlobals()
// cannot take it away; a test that needs to drive the callback still stubs its
// own over the top, as ReviewQueuePage does.
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root: Document | Element | null = null
  readonly rootMargin: string = ''
  readonly thresholds: ReadonlyArray<number> = []
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
}

globalThis.IntersectionObserver = NoopIntersectionObserver

// Start MSW server before all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

// Reset handlers after each test
afterEach(() => server.resetHandlers())

// Close server after all tests
afterAll(() => server.close())
