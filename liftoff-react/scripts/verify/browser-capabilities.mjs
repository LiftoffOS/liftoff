#!/usr/bin/env node
// Do the response headers actually permit the features we shipped?
//
// This exists because defects like these are invisible to every other check:
//
//   1. `Permissions-Policy: microphone=()` denies the microphone to every origin
//      including our own, so the browser refuses before any prompt.
//   2. `script-src 'self'` refuses the AudioWorklet when it is a blob: URL.
//   3. `connect-src` listing https://api-dev... but not wss://api-dev...: CSP
//      matches on scheme, so the dictation socket is blocked before its
//      handshake.
//
// Every one of them passes unit tests, passes a real end-to-end run driven from
// Node, and fails the moment a browser loads the page — because the policies
// come from nginx, which is not in the path under `vite`, and are enforced by
// the browser, which Node is not.
//
// So: assert the policies themselves. Statically against nginx.conf, which runs
// anywhere and catches a regression before it deploys, and optionally against a
// live origin with --url, which catches a config that never reached the edge.
//
//   node scripts/verify/browser-capabilities.mjs
//   node scripts/verify/browser-capabilities.mjs --url https://dev.example.com

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * What each shipped browser capability needs from the response headers.
 *
 * Adding a feature that uses a browser capability means adding a row here. The
 * point is that the requirement is written down next to the thing that enforces
 * it, rather than discovered by a person clicking a button in production.
 */
const REQUIREMENTS = [
  {
    feature: 'dictation: microphone capture',
    header: 'permissions-policy',
    // `microphone=()` is an empty allowlist: nobody, including us.
    check: (value) => /microphone=\(\s*self\s*\)/.test(value),
    expected: 'microphone=(self)',
    why: 'getUserMedia is refused at the document level, with no prompt, if the origin is not allowed',
  },
  {
    feature: 'dictation: AudioWorklet module',
    header: 'content-security-policy',
    check: (value) => directive(value, 'script-src').includes("'self'"),
    expected: "script-src including 'self'",
    why: 'an AudioWorklet module is a script; served same-origin it needs self, and a blob: URL would need blob:',
  },
  {
    feature: 'dictation: transcription socket',
    header: 'content-security-policy',
    check: (value) => directive(value, 'connect-src').some((src) => src.startsWith('wss://')),
    expected: 'connect-src including a wss:// origin',
    why: 'CSP matches on scheme — an https:// entry does not authorise a WebSocket to the same host',
  },
]

/** Assets that must be reachable for a capability to work at all. */
const REQUIRED_ASSETS = [
  {
    feature: 'dictation: AudioWorklet module',
    path: '/pcm-forwarder.worklet.js',
    contentType: /javascript/,
  },
]

/** Split a CSP into one directive's source list. */
function directive(csp, name) {
  const match = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `))
  return match ? match.slice(name.length).trim().split(/\s+/) : []
}

/**
 * Stand-in origins for the template's placeholders.
 *
 * nginx.conf is a template now, and docker-entrypoint.sh substitutes a
 * deployment's own hostnames into it at container start. Checking the raw
 * template would read `${API_ORIGIN_WS}` as the CSP's websocket entry and
 * report that no wss:// origin is permitted — a finding about the placeholder,
 * not about the policy. So render it the way the entrypoint does, with
 * throwaway hosts, and check what a browser would actually be sent. `.invalid`
 * is reserved by RFC 2606 and can never resolve, so nothing here can be
 * mistaken for a real deployment or accidentally contacted.
 */
const PLACEHOLDER_STANDINS = {
  API_ORIGIN: 'https://api.example.invalid',
  API_ORIGIN_WS: 'wss://api.example.invalid',
  DEVELOPER_PROXY_ORIGIN: 'https://proxy.example.invalid',
}

function renderTemplate(conf) {
  return conf.replace(/\$\{([A-Z_]+)\}/g, (whole, name) => {
    const standin = PLACEHOLDER_STANDINS[name]
    if (!standin) {
      // A new placeholder nobody taught this script about would otherwise be
      // checked as a literal and quietly pass or quietly fail.
      throw new Error(`browser-capabilities: no stand-in for \${${name}} — add one to PLACEHOLDER_STANDINS`)
    }
    return standin
  })
}

/** Headers as nginx is configured to send them, whether or not anything is deployed. */
function headersFromNginxConf() {
  const conf = renderTemplate(readFileSync(join(ROOT, 'nginx.conf.template'), 'utf8'))
  const headers = {}
  // add_header Name "value" always;  — ignore commented-out lines.
  const re = /^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"/gm
  let match
  while ((match = re.exec(conf)) !== null) {
    headers[match[1].toLowerCase()] = match[2]
  }
  return headers
}

async function headersFromOrigin(url) {
  // An origin that cannot be reached is a failed check, not a crashed script:
  // this runs in CI, where a stack trace tells nobody what to fix.
  let res
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (err) {
    return { __unreachable: err.message }
  }
  const headers = {}
  res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
  return headers
}

function checkHeaders(headers, source) {
  const failures = []
  if (headers.__unreachable) {
    return [`could not reach ${source}\n    ${headers.__unreachable}`]
  }
  for (const req of REQUIREMENTS) {
    const value = headers[req.header]
    if (value === undefined) {
      failures.push(`${req.feature}\n    ${source} sends no ${req.header}\n    need: ${req.expected}\n    why:  ${req.why}`)
      continue
    }
    if (!req.check(value)) {
      failures.push(
        `${req.feature}\n    ${req.header} does not permit it\n    need: ${req.expected}\n    got:  ${value.slice(0, 160)}${value.length > 160 ? '…' : ''}\n    why:  ${req.why}`,
      )
    }
  }
  return failures
}

async function checkAssets(baseUrl) {
  const failures = []
  for (const asset of REQUIRED_ASSETS) {
    try {
      const res = await fetch(new URL(asset.path, baseUrl))
      const type = res.headers.get('content-type') ?? ''
      if (!res.ok) {
        failures.push(`${asset.feature}\n    ${asset.path} returned ${res.status}`)
      } else if (!asset.contentType.test(type)) {
        failures.push(`${asset.feature}\n    ${asset.path} served as "${type}", expected ${asset.contentType}`)
      }
    } catch (err) {
      failures.push(`${asset.feature}\n    ${asset.path} could not be fetched: ${err.message}`)
    }
  }
  return failures
}

const urlFlag = process.argv.indexOf('--url')
const liveUrl = urlFlag !== -1 ? process.argv[urlFlag + 1] : null

const failures = []

failures.push(...checkHeaders(headersFromNginxConf(), 'nginx.conf').map((f) => `[config] ${f}`))

if (liveUrl) {
  failures.push(...checkHeaders(await headersFromOrigin(liveUrl), liveUrl).map((f) => `[live] ${f}`))
  failures.push(...(await checkAssets(liveUrl)).map((f) => `[live] ${f}`))
}

if (failures.length > 0) {
  console.error(`\n✖ browser-capabilities: ${failures.length} problem(s)\n`)
  for (const failure of failures) console.error(`  ${failure}\n`)
  console.error('These fail only in a browser. Tests and server-side end-to-end runs cannot see them.\n')
  process.exit(1)
}

const scope = liveUrl ? `nginx.conf + ${liveUrl}` : 'nginx.conf'
console.log(`✓ browser-capabilities: ${REQUIREMENTS.length} policy requirement(s) satisfied (${scope})`)
