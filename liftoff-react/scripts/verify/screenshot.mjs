import fs from 'node:fs'
import puppeteer from 'puppeteer'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { PUBLIC_ROUTES, VIEWPORTS, OUT, BASE } from './routes.mjs'
import { normalize } from './normalize.mjs'
import { interactionStates } from './interactions.mjs'

function applyMask(png, rects) {
  for (const { x, y, w, h } of rects) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const idx = (png.width * j + i) << 2
    if (idx >= 0 && idx < png.data.length) { png.data[idx] = png.data[idx+1] = png.data[idx+2] = 0; png.data[idx+3] = 255 }
  }
}
async function shot(page, rects) { const cur = PNG.sync.read(await page.screenshot()); applyMask(cur, rects); return cur }
function cmp(name, cur, failures, update) {
  const f = BASE + name + '.png'
  if (update) { fs.writeFileSync(f, PNG.sync.write(cur)); return }
  if (!fs.existsSync(f)) { failures.push(`${name}: no baseline`); return }
  const b = PNG.sync.read(fs.readFileSync(f))
  if (b.width !== cur.width || b.height !== cur.height) { failures.push(`${name}: size changed`); return }
  const diff = new PNG({ width: cur.width, height: cur.height })
  const n = pixelmatch(b.data, cur.data, diff.data, cur.width, cur.height, { threshold: 0.1 })
  if (n / (cur.width * cur.height) > 0.001) { fs.writeFileSync(OUT + 'diff_' + name + '.png', PNG.sync.write(diff)); failures.push(`${name}: ${n}px changed`) }
}

export async function run({ base, update }) {
  fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(BASE, { recursive: true })
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const failures = []
  for (const route of PUBLIC_ROUTES) for (const vp of VIEWPORTS) {
    const page = await browser.newPage()
    await page.setViewport({ width: vp.w, height: vp.h })
    await page.evaluateOnNewDocument(() => { let s = 42; Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff } }) // seed
    await page.goto(base + route, { waitUntil: 'networkidle0', timeout: 60000 })
    await new Promise(r => setTimeout(r, 1500))
    const rects = await normalize(page)
    const vpName = vp.w < 500 ? 'mobile' : 'desktop'
    const key = `${route.replace(/\W+/g, '_') || 'root'}_${vpName}`
    cmp(`${key}_default`, await shot(page, rects), failures, update)
    for (const st of await interactionStates(page, vpName)) {
      try { await st.apply(); await normalize(page); cmp(`${key}_${st.name}`, await shot(page, rects), failures, update) } catch { /* state not present */ }
      await page.goto(base + route, { waitUntil: 'networkidle0' }).catch(() => {}) // reset between states
      await normalize(page)
    }
    await page.close()
  }
  await browser.close()
  return failures
}
