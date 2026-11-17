// Assert each behavior-load-bearing singleton module maps to EXACTLY ONE emitted chunk. If a chunk
// change ever duplicated e.g. AuthContext into a lazy chunk, useContext() would silently return the
// default and auth would break with no visual symptom. Requires a build with sourcemaps
// (build.sourcemap:true) so each chunk's .js.map lists its source modules.
import fs from 'node:fs'
import path from 'node:path'

const DIST = path.resolve('dist/assets')
// The singletons whose duplication breaks functionality (from the behavior-preservation model).
const SINGLETONS = [
  'src/config/firebase',
  'src/contexts/AuthContext',
  'src/contexts/ToastContext',
  'src/contexts/FeatureFlagsContext',
  'src/contexts/OnboardingContext',
  'src/providers/QueryProvider',
  'src/lib/analytics',
]
export function run() {
  const maps = fs.readdirSync(DIST).filter(f => f.endsWith('.js.map')).map(f => path.join(DIST, f))
  const failures = []
  for (const mod of SINGLETONS) {
    const inChunks = maps.filter(m => fs.readFileSync(m, 'utf8').includes(mod + '.'))
    if (inChunks.length > 1) failures.push(`DUPLICATED singleton "${mod}" in ${inChunks.length} chunks: ${inChunks.map(c => path.basename(c)).join(', ')}`)
    if (inChunks.length === 0) failures.push(`singleton "${mod}" not found in any chunk (sourcemaps enabled?)`)
  }
  return failures
}
