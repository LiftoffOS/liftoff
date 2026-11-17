// CI gate for the dashboard code-split. Catches the two CSS failure modes this
// project has shipped more than once:
//
//   1. COUPLING — a shared component (rendered on several lazy routes) whose
//      stylesheet is missing from a route that renders it, so it renders
//      unstyled (e.g. the connect-integration modal on /dashboard/knowledge and
//      /dashboard/agents/connect).
//   2. BLOAT — a route/component stylesheet leaking into the entry chunk (loads
//      on every route), usually via a CSS side-effect import on
//      a barrel-re-exported component.
//   3. ORPHAN — a stylesheet under src/ that nothing imports. It ships nothing
//      and styles nothing, so editing it has no effect and reviewing it gives a
//      false account of how a page looks. Rules 1 and 2 are blind to it by
//      construction: they reason about the bundle, and an unimported file never
//      reaches the bundle to leave a token in it. InsightsPage.css, SSNInput.css
//      and AddressInput.css were all in this state, left behind when their
//      markup moved to shared styles.
//
// Runs after `vite build` (which emits .vite/manifest.json). For each shared
// stylesheet, `token` is a class fragment unique to it — it appears both in the
// CSS that DEFINES the classes and in the JS chunks that RENDER them. So the
// gate derives consumers from the bundle itself (grep the built JS for the
// token) rather than a hand-maintained route list that always ends up one route
// behind. It then asserts every route whose JS uses the classes also loads a
// defining stylesheet, and that the CSS never sits in the entry chunk. Finally
// it deletes the manifest so it is neither deployed nor counted against the
// bundle budget. Any violation fails the build and blocks the deploy.
//
// Add a row to SHARED_STYLESHEETS when a new shared component gets its own
// extracted stylesheet — just its unique class token, nothing route-specific.

import fs from 'node:fs'
import path from 'node:path'

const DIST = 'dist'
const MANIFEST = path.join(DIST, '.vite', 'manifest.json')
const ASSETS = path.join(DIST, 'assets')

// Dashboard-split stylesheets: extracted from a page CSS so a shared component's
// styles travel with the component's chunk, and must not leak into the entry.
// (teamBuilderInput.css is intentionally NOT here — it styles RoleInput and is
// legitimately global/entry-loaded, so the entry-bloat rule does not apply to
// it.)
const SHARED_STYLESHEETS = [
  { name: 'integrationsSelector', token: 'integration-chip' },
  { name: 'connectionModals', token: 'connection-modal__' },
  // The connection cards themselves, not the modal that connects them. Was
  // missing, and two routes (team explore's connector step and knowledge)
  // shipped the cards with no styling at all while every check here
  // passed — the same gap, and the same silence, as fileUploadPopover below.
  { name: 'connectionCard', token: 'connection-card__' },
  { name: 'filePicker', token: 'file-picker__' },
  // Was missing, and the gap is what let the dashboard home composer ship the
  // attachment picker with no styling at all: every check here passed while the
  // popover rendered as bare icons and run-together labels.
  { name: 'fileUploadPopover', token: 'file-upload-popover' },
  // The mention picker renders into a portal from the same composer, so it has
  // the same way of going wrong.
  { name: 'agentMentionList', token: 'agent-mention-list' },
]

let failed = false
const fail = (m) => { console.error('  ✗ ' + m); failed = true }
const routeName = (k) => k.split('/').pop()

if (!fs.existsSync(MANIFEST)) {
  console.error(`css-closure: ${MANIFEST} not found — vite build must run with build.manifest = true`)
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const files = fs.existsSync(ASSETS) ? fs.readdirSync(ASSETS) : []
const read = (f) => fs.readFileSync(path.join(ASSETS, f), 'utf8')
const cssAll = files.filter(f => f.endsWith('.css'))
const jsAll = files.filter(f => f.endsWith('.js'))

// static-import closure (js + css chunk files) for a manifest key. Dynamic
// imports are separate lazy chunks and are deliberately not followed.
function closure(key, acc = { js: new Set(), css: new Set() }, seen = new Set()) {
  const e = manifest[key]
  if (!e || seen.has(key)) return acc
  seen.add(key)
  if (e.file && e.file.endsWith('.js')) acc.js.add(e.file.replace(/^assets\//, ''))
  for (const c of e.css || []) acc.css.add(c.replace(/^assets\//, ''))
  for (const imp of e.imports || []) closure(imp, acc, seen)
  return acc
}

const entryKey = Object.keys(manifest).find(k => manifest[k].isEntry)
const entry = closure(entryKey)
const routeKeys = Object.keys(manifest).filter(k => /\/pages\/.*\.tsx$/.test(k))

let checks = 0
for (const { name, token } of SHARED_STYLESHEETS) {
  const defFiles = new Set(cssAll.filter(f => read(f).includes(token)))  // CSS defining the classes
  const useChunks = new Set(jsAll.filter(f => read(f).includes(token)))   // JS chunks rendering them
  if (defFiles.size === 0) { fail(`${name}: no built CSS defines "${token}"`); continue }

  // COVERAGE — every route whose JS renders the classes must load a defining stylesheet.
  for (const rk of routeKeys) {
    const c = closure(rk)
    const usesToken = [...entry.js, ...c.js].some(f => useChunks.has(f))
    if (!usesToken) continue
    checks++
    const styled = [...entry.css, ...c.css].some(f => defFiles.has(f))
    if (!styled) fail(`${name} ("${token}"): ${routeName(rk)} renders these classes but loads none of their CSS — it renders unstyled`)
  }

  // ANTI-BLOAT — the defining CSS must not sit in the entry chunk.
  checks++
  if ([...entry.css].some(f => defFiles.has(f))) fail(`${name} ("${token}"): defining CSS is in the entry chunk — bloats every route incl. marketing`)
}

// ORPHAN — every stylesheet under src/ must be imported by some source file.
// Derived from the source tree, not a maintained list, so a new stylesheet is
// covered the day it is added. Only relative specifiers are resolved; a bare
// one (`@xyflow/react/dist/style.css`) is a package stylesheet, not ours.
const SRC = 'src'
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    e.isDirectory() ? walk(p, out) : out.push(p)
  }
  return out
}

const tree = walk(SRC)
const imported = new Set()
for (const src of tree.filter(f => /\.(ts|tsx|js|jsx|css)$/.test(f))) {
  const text = fs.readFileSync(src, 'utf8')
  const specs = [
    ...text.matchAll(/import\s+['"]([^'"]+\.css)['"]/g),
    ...text.matchAll(/@import\s+(?:url\()?['"]([^'"]+\.css)['"]/g),
  ].map(m => m[1])
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue
    imported.add(path.normalize(path.join(path.dirname(src), spec)))
  }
}

for (const sheet of tree.filter(f => f.endsWith('.css'))) {
  checks++
  if (!imported.has(path.normalize(sheet))) {
    fail(`orphan stylesheet: ${sheet} — nothing imports it, so it styles nothing and ships nothing. Delete it, or import it where its classes are rendered.`)
  }
}

if (failed) {
  console.error(`css-closure: FAILED (${checks} checks)`)
  process.exit(1)
}
console.log(`✓ css-closure: ${checks} route/stylesheet checks pass (every consumer styled, no entry bloat, no orphans)`)
// Manifest was only needed for this check — drop it so it is not shipped or
// counted toward the bundle-size budget.
fs.rmSync(path.join(DIST, '.vite'), { recursive: true, force: true })
