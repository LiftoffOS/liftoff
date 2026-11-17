// The card has to say WHICH step of the approved workflow is asking.
//
// A card that says only "Create a pull request review on acme/webapp for pull
// request #42" does not say this is step s7 of the workflow the operator has
// already approved. When it says so, a mis-gated step is obvious at a glance
// instead of needing the logs to find.
//
// The provenance was already travelling: the tenant runtime attaches it at the
// gate and platform-backend's DTO says in as many words that it is "passed
// straight through to the /review surface". Only this app's type never declared
// the field, so the value reached the browser and was discarded — wired at two
// ends and dropped at the third.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const PAGE = readFileSync(join(__dirname, 'ReviewQueuePage.tsx'), 'utf8')
const SERVICE = readFileSync(join(__dirname, '..', '..', 'services', 'oversight.ts'), 'utf8')

describe('the approval type carries the provenance the server sends', () => {
  it('declares context on HitlApproval', () => {
    const at = SERVICE.indexOf('export interface HitlApproval')
    const block = SERVICE.slice(at, SERVICE.indexOf('\n}', at))
    expect(block).toContain('context?:')
  })

  it('declares the declared-step shape the runtime writes', () => {
    expect(SERVICE).toContain('declaredStep?:')
    expect(SERVICE).toContain('inDeclaredScope?:')
  })
})

describe('the card renders which step is asking', () => {
  it('names the step when the action is in declared scope', () => {
    expect(PAGE).toContain('of the approved workflow')
  })

  it('shows the step DESCRIPTION, never its id', () => {
    // INVERTED. This used to require "Outside the approved workflow" and a
    // deviation modifier. Both are gone.
    //
    // The id was internal vocabulary — the same mistake as the `Level 3` badge
    // c1bf9f0 removed. And the deviation line can be FALSE: it can name a step
    // as being outside the workflow when the step is a declared one (say,
    // "Resolve the Slack channel so the notification can be posted."). One line
    // right and one wrong, asserted with equal confidence, beside a reason that
    // already explained the gate.
    expect(PAGE).toContain('declaredStep.description')
    expect(PAGE).not.toMatch(/Outside the approved workflow \$\{|`Outside the approved workflow/)
    expect(PAGE).not.toMatch(/`Step \$\{/)
  })

  it('renders nothing when the action is NOT in declared scope', () => {
    // The reason line already says why. A second, competing line is noise when
    // it is right and actively misleading when it is not.
    expect(PAGE).toMatch(/declaredStep && approval\.context\.inDeclaredScope \?/)
  })

  it('renders nothing at all when no step declared the action', () => {
    // The conversational path has no declared step, and approvals raised before
    // the runtime carried it have none either. Neither should draw an empty row.
    expect(PAGE).toMatch(/declaredStep && approval\.context\.inDeclaredScope \?/)
    expect(PAGE).toMatch(/\) : null\}/)
  })
})

describe('an unknown gate reason degrades instead of rendering nothing', () => {
  // blast-radius-gate.ts states the stake: the queue maps reasons through a
  // static Record<GateReason, string>, and an unlabelled reason draws an EMPTY
  // line exactly where the card is supposed to say why a person is being asked.
  //
  // `GateReason` exists in three copies — the shared package, the services that
  // import it, and this app's hand-typed union — and only the first is
  // authoritative. TypeScript checks the Record against OUR copy, so
  // completeness here is relative to a union that can itself be stale.
  it('routes both render sites through the fallback', () => {
    expect(PAGE).toContain('function reasonLabel(')
    expect(PAGE).toContain("?? 'Needs review'")
    // No site may read the raw map — that is the one that can render blank.
    expect(PAGE).not.toMatch(/reasonLabels\[approval\.reason\]/)
  })

  it('uses it on the list card and on the detail panel', () => {
    const uses = PAGE.match(/reasonLabel\(approval\.reason\)/g) ?? []
    expect(uses).toHaveLength(2)
  })
})
