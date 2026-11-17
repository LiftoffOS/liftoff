import puppeteer from 'puppeteer'
import { PUBLIC_ROUTES } from './routes.mjs'

export async function run({ base }) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const failures = []
  for (const route of ['/', '/why-liftoff', '/about-us']) {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    const warns = []
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') warns.push(m.text()) })
    page.on('pageerror', e => warns.push('pageerror: ' + e.message))
    await page.evaluateOnNewDocument(() => {
      window.__s = []
      const s = () => { const r = document.getElementById('root'); window.__s.push({ txt: r ? (r.textContent||'').trim().length : -1 }); if (performance.now() < 4000) requestAnimationFrame(s) }
      requestAnimationFrame(s)
    })
    await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await new Promise(r => setTimeout(r, 4200))
    const s = await page.evaluate(() => window.__s)
    let zeroRuns = 0, seen = false, inZero = false
    for (const x of s) { if (x.txt > 200) { seen = true; inZero = false } if (seen && x.txt < 50) { if (!inZero) zeroRuns++; inZero = true } }
    const hyd = warns.filter(w => /hydrat|#418|did not match|server rendered/i.test(w))
    if (zeroRuns > 0) failures.push(`${route}: white-flash zeroRuns=${zeroRuns}`)
    if (hyd.length) failures.push(`${route}: hydration warnings: ${hyd[0]}`)
    await page.close()
  }
  await browser.close()
  return failures
}
