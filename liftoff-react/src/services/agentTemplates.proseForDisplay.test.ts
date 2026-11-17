// A template's prose carries `{{pick:<object-id>}}` where a destination goes,
// because that is how the destination reaches the hired team: the backend
// substitutes what the person chose, and the distiller carries identifiers
// through verbatim.
//
// The detail page renders that same prose before anyone has picked anything.
// Without this, a person browsing the catalog reads "Post the summary to
// {{pick:alert-channel}}", which is the product showing its own wiring. Each
// object carries the phrase that stands in its place, and it is the same phrase
// the backend substitutes when an optional pick goes unanswered, so the
// sentence on the page is the sentence the team gets.

import { describe, it, expect } from 'vitest'
import { proseForDisplay, type AgentTemplate } from './agentTemplates'

const template = (objects: Array<Record<string, unknown>>): AgentTemplate =>
  ({
    id: 't',
    requiredConnectors: [
      { id: 'req-chat', capability: 'team_chat', role: 'tool', requiredScopes: [], description: 'd', objects },
    ],
    optionalConnectors: [],
  }) as unknown as AgentTemplate

const CHANNEL = {
  id: 'alert-channel',
  kind: 'channel',
  direction: 'write',
  label: 'Where alerts should be posted',
  required: true,
  fallback: 'your team channel',
}

describe('proseForDisplay', () => {
  it('reads as a sentence, not as a placeholder', () => {
    expect(proseForDisplay('Post the summary to {{pick:alert-channel}}.', template([CHANNEL])))
      .toBe('Post the summary to your team channel.')
  })

  it('replaces every occurrence', () => {
    expect(proseForDisplay('{{pick:alert-channel}} and {{pick:alert-channel}}', template([CHANNEL])))
      .toBe('your team channel and your team channel')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(proseForDisplay('Post to {{ pick:alert-channel }}', template([CHANNEL])))
      .toBe('Post to your team channel')
  })

  it('reads the phrase off an optional connector too', () => {
    const t = {
      id: 't',
      requiredConnectors: [],
      optionalConnectors: [
        { id: 'opt-docs', capability: 'documents', role: 'tool', requiredScopes: [], description: 'd', objects: [
          { id: 'working-folder', kind: 'folder', direction: 'write', label: 'l', required: true, fallback: 'the folder they work in' },
        ] },
      ],
    } as unknown as AgentTemplate
    expect(proseForDisplay('Save drafts in {{pick:working-folder}}', t))
      .toBe('Save drafts in the folder they work in')
  })

  it('never shows braces, even for an object nobody declared', () => {
    // The catalog validator rejects this, so it can only arrive from a
    // template edited around it. Braces on screen would still be the worst
    // available outcome.
    const out = proseForDisplay('Post to {{pick:nothing-here}}.', template([CHANNEL]))
    expect(out).not.toMatch(/\{\{/)
    expect(out).toBe('Post to the connected workspace.')
  })

  it('leaves prose with no placeholders untouched', () => {
    expect(proseForDisplay('Review each pull request.', template([CHANNEL])))
      .toBe('Review each pull request.')
  })

  it('leaves an input placeholder the template does not declare', () => {
    // A different namespace with a different answer. Undeclared, it is
    // somebody's literal text and showing it beats swallowing it.
    expect(proseForDisplay('Track {{company_name}} competitors', template([CHANNEL])))
      .toBe('Track {{company_name}} competitors')
  })

  it('resolves a DECLARED input to its fallback when nothing is typed', () => {
    // The phrase the backend substitutes for a blank at hire, so the sentence
    // read before hiring is the sentence the team gets.
    const t = {
      ...template([CHANNEL]),
      inputs: [{ id: 'company_website', label: 'Website', type: 'url' as const, required: false, fallback: "the company's own website" }],
    }
    expect(proseForDisplay('Argue from {{company_website}} only', t))
      .toBe("Argue from the company's own website only")
  })

  it('prefers what the person actually typed', () => {
    const t = {
      ...template([CHANNEL]),
      inputs: [{ id: 'company_website', label: 'Website', type: 'url' as const, required: false, fallback: "the company's own website" }],
    }
    expect(proseForDisplay('Argue from {{company_website}} only', t, { company_website: 'acme.com' }))
      .toBe('Argue from acme.com only')
  })

  it('removes a declared input that has neither an answer nor a fallback', () => {
    // Matches applyTemplateInputs: an empty substitution beats leaving braces
    // in a sentence somebody reads.
    const t = {
      ...template([CHANNEL]),
      inputs: [{ id: 'company_name', label: 'Company', type: 'text' as const, required: true }],
    }
    expect(proseForDisplay('Track {{company_name}} closely', t)).toBe('Track  closely')
  })

  it('leaves a literal example alone', () => {
    expect(proseForDisplay('{filename}_v1.xlsx', template([CHANNEL]))).toBe('{filename}_v1.xlsx')
  })
})

// The gallery shows the CONNECTED reading of every clause, deliberately.
//
// Nothing is bound while somebody is still deciding whether to hire, so an
// unbound reading would describe the least capable version of the team to the
// one person who most needs to see what it can do.
describe('proseForDisplay with connector variants', () => {
  const withVariants = (): AgentTemplate =>
    ({
      id: 't',
      requiredConnectors: [],
      optionalConnectors: [{
        id: 'opt-team-chat',
        capability: 'team_chat',
        role: 'tool',
        requiredScopes: [],
        description: 'd',
        objects: [CHANNEL],
        prose: {
          whenBound: 'post it to {{pick:alert-channel}}',
          whenUnbound: 'include it in your written output',
        },
      }],
    }) as unknown as AgentTemplate

  it('reads as the connected version, with the destination as a phrase', () => {
    expect(proseForDisplay('Produce the summary and {{connector:opt-team-chat}}.', withVariants()))
      .toBe('Produce the summary and post it to your team channel.')
  })

  it('never shows the unbound wording on the gallery', () => {
    expect(proseForDisplay('Produce it and {{connector:opt-team-chat}}.', withVariants()))
      .not.toContain('written output')
  })

  it('leaves no braces behind for a reference nothing declares', () => {
    // A template edited past the catalog validator. Braces on the page are
    // worse than a slightly short sentence.
    expect(proseForDisplay('Produce it and {{connector:opt-missing}}.', withVariants()))
      .not.toContain('{{')
  })
})
