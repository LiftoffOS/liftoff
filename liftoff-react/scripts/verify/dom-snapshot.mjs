import fs from 'node:fs'
import puppeteer from 'puppeteer'
import { PUBLIC_ROUTES, BASE } from './routes.mjs'
import { interactionStates } from './interactions.mjs'

// Serialize #root: tag + sorted classes + trimmed text + key aria/role attrs. Strips inline style
// (animation/transform values are frame-dependent) so it's animation-proof but structure-sensitive.
const SERIALIZE = `(() => {
  const walk = (el) => {
    if (el.nodeType === 3) return (el.textContent || '').trim() ? '#' + el.textContent.trim().slice(0,60) : ''
    if (el.nodeType !== 1) return ''
    const cls = [...el.classList].sort().join('.')
    const a = ['role','aria-label','aria-expanded','aria-hidden','type','href','placeholder','disabled'].map(k => el.hasAttribute(k) ? k+'='+el.getAttribute(k) : '').filter(Boolean).join(',')
    const kids = [...el.childNodes].map(walk).filter(Boolean).join('|')
    return el.tagName.toLowerCase() + (cls?'.'+cls:'') + (a?'['+a+']':'') + (kids?'{'+kids+'}':'')
  }
  return walk(document.getElementById('root'))
})()`

export async function run({ base, update }) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const failures = []
  for (const route of PUBLIC_ROUTES) {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.goto(base + route, { waitUntil: 'networkidle0', timeout: 60000 })
    await new Promise(r => setTimeout(r, 1500))
    const key = route.replace(/\W+/g, '_') || 'root'
    const states = { default: null, ...Object.fromEntries((await interactionStates(page, 'desktop')).map(s => [s.name, s])) }
    for (const [name, st] of Object.entries(states)) {
      if (st) { try { await st.apply() } catch {} }
      const dom = await page.evaluate(SERIALIZE)
      const f = `${BASE}dom-${key}-${name}.txt`
      if (update) fs.writeFileSync(f, dom)
      else if (!fs.existsSync(f)) failures.push(`dom ${key}/${name}: no baseline`)
      else if (fs.readFileSync(f, 'utf8') !== dom) failures.push(`dom ${key}/${name}: STRUCTURE CHANGED`)
      await page.goto(base + route, { waitUntil: 'networkidle0' }).catch(() => {})
    }
    await page.close()
  }
  await browser.close()
  return failures
}
