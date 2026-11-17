import { spawn } from 'node:child_process'
import * as shot from './screenshot.mjs'
import * as dom from './dom-snapshot.mjs'
import * as css from './css-fingerprint.mjs'
import * as flash from './flash-probe.mjs'
import * as modules from './module-uniqueness.mjs'

const update = process.argv.includes('--update')
const PORT = 4390, base = `http://localhost:${PORT}`
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT)], { stdio: 'ignore' })
await new Promise(r => setTimeout(r, 4000))
try {
  const modFail = update ? [] : modules.run()               // 0. singleton-duplication guard (functionality)
  const cssFail = css.run({ update })                       // 1. deterministic CSS backbone
  const domFail = await dom.run({ base, update })           // 2. DOM structure incl. interaction states
  const shotFail = await shot.run({ base, update })         // 3. frozen-animation visual backstop + interactions
  const flashFail = update ? [] : await flash.run({ base }) // 4. flash/hydration
  const all = [...modFail, ...cssFail, ...domFail, ...shotFail, ...flashFail]
  if (update) console.log('✓ baselines updated')
  else if (all.length) { console.error('✗ verify:visual FAILED:\n  ' + all.join('\n  ')); process.exitCode = 1 }
  else console.log('✓ verify:visual passed (modules + CSS + DOM/interactions + frozen screenshots + flash)')
} finally { preview.kill('SIGKILL') }
