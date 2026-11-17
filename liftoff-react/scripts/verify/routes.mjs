// The routes the visual checks cover. This is an application: every route but
// /login needs a session, so /login is the one page a cold browser can render
// and therefore the only one with a baseline to compare against.
export const PUBLIC_ROUTES = ['/login']
export const VIEWPORTS = [{ w: 1280, h: 900 }, { w: 390, h: 844 }]
export const OUT = new URL('./out/', import.meta.url).pathname
export const BASE = new URL('./baseline/', import.meta.url).pathname
