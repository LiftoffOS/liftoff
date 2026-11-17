// Derive the nginx SPA-route allowlist from src/App.tsx.
//
// WHY THIS EXISTS
// ---------------
// nginx served `try_files $uri $uri/index.html /index.html`, so every URL that
// was not a real file fell through to the app shell with HTTP 200. A path that
// does not exist answered 200 with the same 25KB of HTML as a path that does,
// which makes an agent probing the site conclude that every path exists. The
// app already renders correct 404 UI for those routes (the `path="*"` catch-all
// in App.tsx) -- only the status code was wrong.
//
// nginx needs to know which paths are real routes, and the one thing that must
// never happen is a real route answering 404 in production. Hand-maintaining
// that list would guarantee exactly that the first time somebody adds a route
// and forgets this file, so it is generated from App.tsx (the INV-UI-002 single
// source of truth for routes) on every build. Add a route, build, it works.
//
// WHY FULL PATHS, NOT FIRST SEGMENTS
// ----------------------------------
// The first version of this matched on first path segments only (/about-us,
// /dashboard) on the theory that being too strict risks 404ing a real page
// while being too lenient only leaves an obscure subpath answering 200. That
// was wrong in practice: it left /about-us/nope, /pricing/nope and
// /industries/not-a-real-industry all answering 200, which is the same
// soft-404 the change existed to remove, just one level down. Audits probe
// exactly those.
//
// So the allowlist now encodes the whole route tree, nesting and :params
// included, anchored end-to-end. /about-us matches; /about-us/nope does not.
//
// WHY AN AST, NOT A REGEX
// -----------------------
// Route nesting cannot be recovered with a regex over the source. Routes carry
// `element={<ProtectedRoute><Suspense>...</Suspense></ProtectedRoute>}`, so the
// JSX inside an ATTRIBUTE is arbitrarily deep and looks exactly like nesting to
// a line-based parser. TypeScript's own parser is already a devDependency and
// distinguishes attributes from children for free, so this walks real JSX
// children and nothing else.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = resolve(root, 'src/App.tsx')
const OUT = resolve(root, 'nginx/spa-routes.conf')

/** A route's `path` / `index` attributes, or null when it is not a <Route>. */
function routeAttrs(node) {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : null
  if (!opening) return null
  if (opening.tagName.getText?.() !== 'Route' && opening.tagName.escapedText !== 'Route') return null

  let path = null
  let index = false
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue
    const name = attr.name.escapedText
    if (name === 'index') index = true
    if (name === 'path' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
      path = attr.initializer.text
    }
  }
  return { path, index }
}

/** Join a parent route path with a child's, following React Router semantics. */
function joinPath(parent, child) {
  if (child.startsWith('/')) return child // absolute child ignores the parent
  const base = parent === '/' ? '' : parent
  return `${base}/${child}`
}

/**
 * Walk the <Routes> tree and return every full route path the app can render.
 * `index` routes contribute their parent's path. `path="*"` is the catch-all and
 * is deliberately excluded -- it is precisely what should now answer 404.
 */
export function deriveRoutePaths(source) {
  const sf = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const paths = new Set()

  const visit = (node, parent) => {
    const attrs = routeAttrs(node)
    let current = parent

    if (attrs) {
      if (attrs.index) {
        if (parent) paths.add(parent)
      } else if (attrs.path && attrs.path !== '*') {
        current = joinPath(parent ?? '', attrs.path)
        paths.add(current)
      }
    }

    // Only real JSX children. Anything inside element={...} is an attribute and
    // is never reached, which is the entire reason this uses a parser.
    if (ts.isJsxElement(node)) {
      for (const child of node.children) visit(child, current)
    } else if (!attrs) {
      // Non-Route wrappers (fragments, providers, conditionals) keep the walk
      // going without contributing a segment.
      node.forEachChild?.((child) => visit(child, current))
    }
  }

  visit(sf, null)

  if (!paths.has('/')) {
    throw new Error('generate-spa-routes: no "/" route found in App.tsx -- refusing to emit a config that 404s the homepage.')
  }
  // A parser that silently stops matching would emit a tiny allowlist and 404
  // most of the app. Fail the build instead.
  if (paths.size < 40) {
    throw new Error(`generate-spa-routes: only ${paths.size} routes parsed from App.tsx, expected 40+. The parser is probably broken; refusing to emit.`)
  }
  return [...paths].sort()
}

/**
 * Turn a route path into an anchored nginx regex against $request_uri.
 *
 * The leading `~` is load-bearing and must never be dropped: without it nginx
 * reads the key as a literal string to compare, not a regex. It does not error
 * — it just silently never matches. Any path with a static index.html hides
 * this completely (try_files finds that file before the allowlist is ever
 * consulted), so those paths keep working while every client-rendered
 * route — /login, /dashboard, /support — 404s. That is exactly how this shipped
 * broken once, caught only by the route-coverage check against a real nginx.
 */
export function toPattern(path) {
  // Root is special-cased: the generic form below would build "~^//?(\?.*)?$",
  // which also matches "//".
  if (path === '/') return '~^/(\\?.*)?$'

  const body = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '[^/]+' // :param matches one segment
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  // $request_uri carries the query string, so every pattern tolerates one.
  // Trailing slash is allowed because the trailing-slash rewrite runs first and
  // a redirect is friendlier than a 404 if that ordering ever changes.
  return `~^${body === '' ? '/' : body}/?(\\?.*)?$`
}

export function renderConf(paths) {
  const COL = 62
  const row = (key, value) => `    ${key.padEnd(COL)} ${value};`
  const lines = paths.map((p) => {
    const pattern = toPattern(p)
    // Belt and braces for the failure described on toPattern: a key without the
    // `~` is a literal comparison that nginx accepts happily and that never
    // matches, so the config still loads and most of the app 404s.
    if (!pattern.startsWith('~')) {
      throw new Error(`generate-spa-routes: pattern for "${p}" is missing the leading "~", so nginx would treat it as a literal string and never match it.`)
    }
    return row(`"${pattern}"`, 1)
  })

  return `# GENERATED by scripts/generate-spa-routes.mjs -- DO NOT EDIT.
#
# Derived from the <Routes> tree in src/App.tsx on every build. To change what is
# in here, add or remove a <Route> and rebuild. Editing this file by hand will be
# overwritten and, worse, will drift from the routes the app actually serves.
#
# Patterns are anchored end-to-end: /about-us matches, /about-us/nope does not.
# A :param becomes [^/]+, so it spans exactly one segment.
#
# 1 = a real client-side route, serve the SPA shell with 200.
# 0 = not a route, serve a real 404.
#
# Keyed on $request_uri, NOT $uri: the SPA fallback is reached through try_files,
# which rewrites $uri to /index.html on the way, so a $uri map would match
# nothing on exactly the paths this exists to classify. $request_uri keeps the
# original request line, query string included.
map $request_uri $is_spa_route {
${row('default', 0)}
${lines.join('\n')}
}
`
}

// Write ONLY when run as a script, never on import.
//
// The test suite imports these functions to assert the checked-in config still
// matches App.tsx. Without this guard that import re-runs the generator, so the
// drift test rewrites the exact file it is about to compare and can never fail
// -- and an ordinary `vitest run` quietly mutates a tracked file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = deriveRoutePaths(readFileSync(APP, 'utf8'))
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, renderConf(paths))
  console.log(`✓ spa-routes.conf — ${paths.length} routes derived from src/App.tsx`)
}
