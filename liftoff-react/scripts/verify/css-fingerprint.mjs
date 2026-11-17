import fs from 'node:fs'
import path from 'node:path'
import { PUBLIC_ROUTES, BASE } from './routes.mjs'

const DIST = path.resolve('dist')

// CSS a public route loads = the stylesheet <link>s in its served HTML, IN ORDER. A route
// with static output has dist/<route>/index.html; SPA routes fall back to the
// dist/index.html shell (which links the entry stylesheet the route loads first).
function routeHtml(route) {
  const rel = route === '/' ? 'index.html' : `${route.replace(/^\//, '')}/index.html`
  const fp = path.join(DIST, rel)
  return fs.existsSync(fp) ? fp : path.join(DIST, 'index.html')
}
function routeCssFiles(route) {
  const html = fs.readFileSync(routeHtml(route), 'utf8')
  return [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/?([^"]+\.css)"/g)].map(m => m[1])
}
// Ordered (selector -> body) pairs across the route's stylesheets, concatenated in load order.
function fingerprint(route) {
  const rules = []
  for (const f of routeCssFiles(route)) {
    const css = fs.readFileSync(path.join(DIST, f), 'utf8')
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) rules.push(m[1].trim().replace(/\s+/g, ' ') + '|' + m[2].trim())
  }
  return rules
}

export function run({ update }) {
  const failures = []
  for (const route of PUBLIC_ROUTES) {
    const fp = fingerprint(route)
    const file = path.join(BASE, `css-${route.replace(/\W+/g, '_') || 'root'}.json`)
    if (update) { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(file, JSON.stringify(fp, null, 0)); continue }
    const base = JSON.parse(fs.readFileSync(file, 'utf8'))
    const curSet = new Set(fp)
    const removed = base.filter(r => !curSet.has(r))            // a REMOVED/changed rule (the hero bug)
    const moved = base.filter((r, i) => fp[i] !== r).length      // any position/body change
    if (removed.length || moved) failures.push(`${route}: ${removed.length} rules removed/changed, order-diff at ${moved} positions\n   e.g. ${removed.slice(0,3).join('  ||  ')}`)
  }
  return failures
}
