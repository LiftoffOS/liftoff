// Post-build step: emit max-level gzip (.gz) AND brotli (.br) siblings for every compressible
// asset in dist/. nginx's `gzip_static on;` / `brotli_static on;` then serve these precompressed
// files directly (no per-request CPU) and fall back to on-the-fly compression for anything without
// a sibling.
//
// This ONLY adds new *.gz / *.br files next to the originals — it never modifies, reorders, or
// deletes any built file. gzip and brotli are lossless, so the browser decompresses each to
// byte-identical content. Nothing the app runs (markup, styles, JavaScript, animations, timing)
// is affected.
//
// Dependency-free — uses only Node's built-in zlib.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const distDir = path.resolve(fileURLToPath(import.meta.url), '../../dist')
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json'])

let count = 0
let originalTotal = 0
let gzTotal = 0
let brTotal = 0

function compress(file) {
  const buf = fs.readFileSync(file)
  // Skip when neither compressor helps (very small files can grow) — no point shipping a sibling
  // that's larger than the original.
  const gz = zlib.gzipSync(buf, { level: 9 })
  if (gz.length < buf.length) {
    fs.writeFileSync(`${file}.gz`, gz)
    gzTotal += gz.length
  }
  const br = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  })
  if (br.length < buf.length) {
    fs.writeFileSync(`${file}.br`, br)
    brTotal += br.length
  }
  count++
  originalTotal += buf.length
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (COMPRESSIBLE.has(path.extname(entry.name))) {
      compress(full)
    }
  }
}

if (!fs.existsSync(distDir)) {
  console.error(`precompress: dist directory not found at ${distDir}`)
  process.exit(1)
}

walk(distDir)
console.log(
  `✓ Precompressed ${count} asset(s) → .gz + .br ` +
    `(${(originalTotal / 1024).toFixed(0)} KB → gz ${(gzTotal / 1024).toFixed(0)} KB, br ${(brTotal / 1024).toFixed(0)} KB)`,
)
