// The web app hand-types two vocabularies the server owns.
//
// `GateReason` and `ApprovalStatus` are defined in @liftoffos/governance-types.
// tenant-runtime and governance-engine IMPORT them, so they cannot drift. This
// app has no @liftoffos dependency at all, so it retypes them by hand — and
// nothing reconciles the copies.
//
// The consequence is specific, and blast-radius-gate.ts in tenant-runtime spells
// it out: ReviewQueuePage maps a reason through a static
// Record<GateReason, string>. TypeScript checks that record against THIS union,
// so its completeness is guaranteed only relative to a copy that may itself be
// stale. A reason the server sends and this file has never heard of renders an
// EMPTY line exactly where the card is supposed to say why a person is being
// asked. `blast_radius` sat unreachable in two consumers for two minor versions
// before anyone noticed.
//
// This is the near half of a fence whose far half lives in
// packages/governance-types/src/hard-invariant-effects.test.ts. There, a
// `Record` keyed by the union makes adding a member without listing it a
// COMPILE error, and the list's failure message names this app. Here, the same
// list is pinned so the two must be edited together.
//
// It does not make drift impossible. It makes it loud, in both repos, at the
// moment someone changes the vocabulary. Making it impossible needs this app to
// consume the package, which is a deploy-infrastructure change rather than a
// typing one.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(__dirname, 'oversight.ts'), 'utf8')
const PAGE = readFileSync(
  join(__dirname, '..', 'pages', 'Dashboard', 'ReviewQueuePage.tsx'), 'utf8',
)

/** The members of a hand-typed string-literal union, as written. */
function unionMembers(typeName: string): string[] {
  const at = SRC.indexOf(`export type ${typeName} =`)
  expect(at).toBeGreaterThan(-1)
  const line = SRC.slice(at, SRC.indexOf('\n', at))
  // [a-z0-9_] — NOT [a-z_]. `level_1_gate` has a digit in it, and the narrower
  // class silently dropped it, so the fence reported drift that did not exist.
  // A fence that miscounts the vocabulary is worse than no fence: it trains
  // people to edit the expected list until the failure goes away.
  return [...line.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort()
}

describe('the vocabularies match the ones the server owns', () => {
  it('GateReason carries every member', () => {
    // ⚠️ Mirrors GATE_REASONS in @liftoffos/governance-types. Adding one there
    // fails that package's own test, whose message points here. Adding one here
    // without a `reasonLabels` entry renders a blank on the card.
    expect(unionMembers('GateReason')).toEqual([
      'blast_radius',
      'communication_review',
      'contract_deviation',
      'destructive_gate',
      'external_content_write',
      'level_1_gate',
      'merge_to_main',
      'rate_limit_exceeded',
      'sensitive_work',
      'super_destructive_gate',
    ])
  })

  it('ApprovalStatus carries every member', () => {
    // ⚠️ Mirrors APPROVAL_STATUSES in @liftoffos/governance-types.
    expect(unionMembers('ApprovalStatus')).toEqual([
      'approved', 'expired', 'pending', 'rejected', 'withdrawn',
    ])
  })

  it('every gate reason has a label on the card', () => {
    // The gap the fence exists for. A member in the union with no label is a
    // blank line where the reason belongs — TypeScript catches this via
    // Record<GateReason, string>, and this states it in the failure message
    // rather than as a type error someone has to interpret.
    for (const reason of unionMembers('GateReason')) {
      expect(PAGE).toMatch(new RegExp(`\\b${reason}:\\s*'`))
    }
  })

  it('still degrades when a reason arrives that this build has never heard of', () => {
    // The fence makes drift loud; this makes it survivable. A reason the server
    // adds before this app is updated renders as needing review rather than as
    // an empty line.
    expect(PAGE).toContain("?? 'Needs review'")
    expect(PAGE).not.toMatch(/reasonLabels\[approval\.reason\]/)
  })

  it('says where the authoritative copies live', () => {
    // The next person to add a member should not have to discover the
    // duplication first.
    expect(SRC).toContain('@liftoffos/governance-types')
  })
})
