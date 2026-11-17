// This page's fallback settings must match the server's, field for field.
//
// The server is authoritative: `internal-agent-oversight/service.ts` seeds a new
// row with ('balanced', 'important', DEFAULT_SENSITIVE_WORK, 'review'), and its
// reads merge `{ ...DEFAULT_SENSITIVE_WORK, ...stored }`. The page's own object
// is what it shows and edits before that row is known — so any field that
// disagrees is a value the page can write back OVER the server's, and the merge
// above then honours it permanently.
//
// `mergeToMain` disagreed, in the direction that costs the most. The server
// comment records why it defaults ON: the category shipped `false`, so every
// tenant created before it, and every one after who never opened the page, had
// the one control governing merges to a default branch silently switched off.
// The server was fixed and this copy was not, so the page could put it back.
//
// A source assertion rather than a rendering one. The defect is two constants in
// two repositories disagreeing; no amount of driving this component proves they
// agree, and the assertion that would have caught it is this one.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(__dirname, 'OversightPage.tsx'), 'utf8')

/** The `defaultOversightSettings` literal, as text. */
function defaultsBlock(): string {
  const at = SRC.indexOf('const defaultOversightSettings')
  expect(at).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n}', at)
  expect(end).toBeGreaterThan(at)
  return SRC.slice(at, end)
}

describe('the page defaults match the server defaults', () => {
  // Mirrors DEFAULT_SENSITIVE_WORK in
  // liftoff-platform-backend/src/internal-agent-oversight/types.ts, plus the
  // column defaults in that service's seeding INSERT.
  const SERVER_SENSITIVE_WORK: Record<string, boolean> = {
    customerCommunication: true,
    financialActions: true,
    dataChanges: false,
    externalPublishing: true,
    hiringDecisions: false,
    mergeToMain: true,
  }

  it.each(Object.entries(SERVER_SENSITIVE_WORK))('%s is %s, as the server has it', (key, value) => {
    expect(defaultsBlock()).toMatch(new RegExp(`${key}:\\s*${value}\\s*,`))
  })

  it('defaults mergeToMain ON', () => {
    // Called out on its own because this is the one that drifted, and because a
    // safety category that arrives off is indistinguishable from one nobody
    // added — the failure is silent, and merging to a default branch is not
    // reversible by the agent that did it.
    expect(defaultsBlock()).toMatch(/mergeToMain:\s*true\s*,/)
    expect(defaultsBlock()).not.toMatch(/mergeToMain:\s*false/)
  })

  it('keeps autonomy, escalation and communication at the seeded row values', () => {
    const block = defaultsBlock()
    expect(block).toMatch(/autonomy:\s*'balanced'/)
    expect(block).toMatch(/escalation:\s*'important'/)
    expect(block).toMatch(/communication:\s*'review'/)
  })

  it('covers every category the page can edit', () => {
    // A category added to the UI without a matching entry here would default to
    // undefined and save as a missing key — which is exactly how mergeToMain
    // came to be "absent from the row entirely" in the first place.
    const labels = SRC.slice(
      SRC.indexOf('const sensitiveWorkLabels'),
      SRC.indexOf('const defaultOversightSettings'),
    )
    for (const key of Object.keys(SERVER_SENSITIVE_WORK)) {
      expect(labels).toContain(`${key}:`)
    }
  })
})

// ── the withdrawn disposition ────────────────────────────────────────────
//
// The other four statuses all claim something about a person — approved,
// refused, or ignored — and every one of those claims is false for a question
// that stopped mattering before anyone answered it.
describe('ApprovalStatus carries withdrawn', () => {
  const SERVICE = readFileSync(join(__dirname, '..', '..', 'services', 'oversight.ts'), 'utf8')

  it('includes it in the union', () => {
    // A hand-typed duplicate of the shared package's copy. Missing the member
    // means the type lies about what the server can send.
    expect(SERVICE).toMatch(/ApprovalStatus =[^\n]*'withdrawn'/)
  })

  it('keeps the four the server already sends', () => {
    for (const s of ['pending', 'approved', 'rejected', 'expired']) {
      expect(SERVICE).toMatch(new RegExp(`ApprovalStatus =[^\\n]*'${s}'`))
    }
  })

  it('says where the authoritative copy lives', () => {
    // Three copies exist and only one is authoritative; the next person adding
    // a status should not have to discover that.
    const at = SERVICE.indexOf('export type ApprovalStatus')
    expect(SERVICE.slice(Math.max(0, at - 1200), at)).toContain('@liftoffos/governance-types')
  })
})
