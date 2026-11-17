// The distillation input contract, and the ratchet over the catalog.
//
// Two halves, and the second is the one that decays. The rules themselves are
// tested against a template built to break each one, because a validator rule
// that cannot fail is decoration — every rule below was written, then watched
// to reject something, then watched to accept the catalog.
//
// The ratchet half freezes what the catalog is TODAY. Enrichment is the
// catalog's cost and it proceeds family by family, so 65 templates must not
// fail at once; but the list only tightens, and a template that gains its flows
// and comes off it can never quietly go back.

import { validateTemplate, agentTemplateZodSchema } from '../validator';
import { getAllTemplates, initTemplateLoader } from '../loader';
import {
  KNOWN_TEMPLATES_WITHOUT_FLOWS,
  KNOWN_TEMPLATES_WITHOUT_EVALS,
  KNOWN_TEMPLATES_WITH_OFF_VOCABULARY_HEADINGS,
  KNOWN_TEMPLATES_WITHOUT_TOOL_NOTES,
  KNOWN_TEMPLATES_WITHOUT_DOMAIN_ALIASES,
  KNOWN_TEMPLATES_WITHOUT_CAPABILITIES,
} from './known-uncontracted-templates';
import { REVIEWED_NOT_APPLICABLE, type ConditionalField } from './reviewed-field-applicability';
import { SECTION_DESTINATION } from '@liftoffos/workforce-types';
import { join } from 'path';

const BASE = {
  id: 'contract-fixture',
  displayName: 'Contract Fixture',
  departmentCategory: 'engineering' as const,
  description: 'A fixture.',
  roleSummary: 'A fixture role.',
  role: 'Fixture',
  responsibilities: '## Responsibilities\n\nDo the thing.',
  additionalContext: '## Rules\n\nBe careful.',
  requiredConnectors: [
    { id: 'req-vc', capability: 'version_control', role: 'tool' as const, description: 'Read changes' },
  ],
  optionalConnectors: [],
  defaultAgentType: 'agent' as const,
  defaultMemoryScope: { readableLayers: ['individual'], writableLayers: ['individual'] },
  defaultTriggerConfig: { type: 'event' as const, eventTopic: 'pr.opened' },
  schemaVersion: 1,
};

function messages(over: Record<string, unknown>): string[] {
  const r = agentTemplateZodSchema.safeParse({ ...BASE, ...over });
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

const FLOW = {
  id: 'a-flow',
  name: 'A flow',
  useWhen: 'A change arrives that has not been looked at.',
  notNeededFor: 'A change already looked at, which b-flow covers.',
  body: 'Look at it.',
};
const SIBLING = {
  id: 'b-flow',
  name: 'B flow',
  useWhen: 'A change that has already been looked at comes back.',
  notNeededFor: 'A first look, which a-flow covers.',
  body: 'Look again.',
};

describe('flow boundaries', () => {
  it('accepts a mutual pair', () => {
    expect(messages({ flows: [FLOW, SIBLING] })).toEqual([]);
  });

  it('rejects a boundary that excludes nothing', () => {
    // The failure this catches is not an error at runtime: both flows match
    // every request, retrieval picks by tie-break, and the agent's behaviour
    // depends on which one sorted first.
    const m = messages({
      flows: [{ ...FLOW, notNeededFor: 'Other kinds of request.' }, SIBLING],
    });
    expect(m.join('\n')).toContain('excludes nothing');
  });

  it('rejects a one-sided boundary', () => {
    const m = messages({
      flows: [FLOW, { ...SIBLING, notNeededFor: 'Requests that are already handled elsewhere.' }],
    });
    expect(m.join('\n')).toContain('does not exclude it back');
  });

  it('rejects two flows sharing one id', () => {
    // The id is the flow's identity: it becomes the skill id and is what
    // survives a redistill. Heading-derived slugs collide, and a Set built from
    // them hid the collision — two bodies under one skill, the second's metrics
    // landing on the first.
    const m = messages({
      flows: [FLOW, { ...SIBLING, id: 'a-flow' }],
    });
    expect(m.join('\n')).toContain('Flow id "a-flow" is declared more than once');
  });

  it('rejects a quoted sample utterance in useWhen', () => {
    // A key written as one phrasing matches that phrasing and misses every
    // other way of asking for the same thing.
    const m = messages({
      flows: [{ ...FLOW, useWhen: 'The user says "can you review this PR for me"' }, SIBLING],
    });
    expect(m.join('\n')).toContain('quotes a sample utterance');
  });
});

describe('evals', () => {
  const SERVED = { id: 'served', turns: ['do it'], expected: { calls_tool: ['post_comment'] } };
  const REFUSED = {
    id: 'refused',
    turns: ['do it again'],
    expected: { never_calls: ['post_comment'] },
    counterpartOf: 'served',
  };

  it('accepts a refusal paired with a served case', () => {
    expect(messages({ evals: [SERVED, REFUSED] })).toEqual([]);
  });

  it('rejects a refusal with no served counterpart', () => {
    // An agent that refuses EVERYTHING passes an unpaired refusal case.
    const m = messages({ evals: [{ ...REFUSED, counterpartOf: undefined }] });
    expect(m.join('\n')).toContain('no served counterpart');
  });

  it('rejects a counterpart naming a case that does not exist', () => {
    const m = messages({ evals: [{ ...REFUSED, counterpartOf: 'nope' }] });
    expect(m.join('\n')).toContain('which no case in this template declares');
  });

  it('rejects two cases sharing one id', () => {
    // A case is addressed by id — by counterpartOf, by the harness's recordings.
    const m = messages({
      evals: [SERVED, { ...SERVED, id: 'served', turns: ['do it differently'] }],
    });
    expect(m.join('\n')).toContain('Eval id "served" is declared more than once');
  });

  it('rejects an expectation that asserts nothing', () => {
    // It would pass for any behaviour at all, which reads in a diff as a case
    // that is passing.
    const m = messages({ evals: [{ id: 'empty', turns: ['x'], expected: {} }] });
    expect(m.join('\n')).toContain('at least one thing');
  });
});

describe('tool notes', () => {
  it('accepts a key a declared requirement provides', () => {
    expect(messages({ toolNotes: { version_control: 'Name the host.' } })).toEqual([]);
  });

  it('rejects a key nothing provides', () => {
    // Keyed by capability so the note survives a different binding — so a key
    // naming no capability is a note attached to no tool.
    const m = messages({ toolNotes: { telepathy: 'Read their mind.' } });
    expect(m.join('\n')).toContain('which no declared connector requirement provides');
  });
});

describe('capability tri-state', () => {
  it('rejects prose describing a capability declared absent', () => {
    // `absent` means the PLATFORM cannot do it. Prose that promises it anyway
    // is a promise nothing can keep, which is the whole reason for a third
    // state.
    const m = messages({
      capabilities: { video_conference: 'absent' },
      additionalContext: '## Rules\n\nJoin the video conference and take notes.',
    });
    expect(m.join('\n')).toContain('declared absent');
  });

  it('leaves live and unwired alone', () => {
    expect(messages({
      capabilities: { version_control: 'live', email_communication: 'unwired' },
    })).toEqual([]);
  });

  it('rejects a declared map that says nothing about a capability a requirement names', () => {
    // A map that states two capabilities absent and nothing about the one
    // the connector provides is half-authored: the distiller would have to
    // guess whether the hire has version control, which is what the third
    // state exists to prevent.
    const m = messages({ capabilities: { sms: 'absent', telephony: 'absent' } });
    expect(m.join('\n')).toContain('declares no state for "version_control"');
  });

  it('does not fail an absent map — presence is the catalog ratchet\'s to hold', () => {
    expect(messages({})).toEqual([]);
  });
});

describe('sections', () => {
  it('rejects a heading with no destination', () => {
    const m = messages({ sections: { '## Improvised Heading': 'Do the thing.' } });
    expect(m.join('\n')).toContain('has no destination');
  });

  it('rejects a body that does not appear in the prose', () => {
    // sections is a parsed VIEW. Two sources of truth for what a template says
    // drift, and the drift is silent: the strings still hire an agent and the
    // sections still route.
    const m = messages({ sections: { '## Responsibilities': 'Something else entirely.' } });
    expect(m.join('\n')).toContain('does not appear in the authored prose');
  });

  it('accepts a faithful split', () => {
    expect(messages({ sections: { '## Responsibilities': 'Do the thing.' } })).toEqual([]);
  });
});

describe('the provenance obligation', () => {
  it('rejects prose promising it with the flag unset', () => {
    const m = messages({
      additionalContext: '## Rules\n\nOnly ever update rows you have actually read this run.',
    });
    expect(m.join('\n')).toContain('writesRequireProvenance is not set');
  });

  it('accepts the same prose with the flag set', () => {
    expect(messages({
      additionalContext: '## Rules\n\nOnly ever update rows you have actually read this run.',
      writesRequireProvenance: true,
    })).toEqual([]);
  });
});

describe('the catalog ratchet', () => {
  initTemplateLoader(join(__dirname, '..', 'catalog'));
  const templates = getAllTemplates();

  it('loads every template', () => {
    expect(templates.length).toBeGreaterThan(60);
  });

  it('has flows on every template not frozen as debt', () => {
    const missing = templates
      .filter((t) => (t.flows ?? []).length === 0)
      .map((t) => t.id)
      .filter((id) => !KNOWN_TEMPLATES_WITHOUT_FLOWS.includes(id));
    expect(missing).toEqual([]);
  });

  it('has evals on every template not frozen as debt', () => {
    const missing = templates
      .filter((t) => (t.evals ?? []).length === 0)
      .map((t) => t.id)
      .filter((id) => !KNOWN_TEMPLATES_WITHOUT_EVALS.includes(id));
    expect(missing).toEqual([]);
  });

  it('only tightens: a template that gained flows is off the baseline', () => {
    // The half that makes it a ratchet rather than a list. Without this the
    // baseline silently becomes a permanent exemption for work already done.
    const stale = KNOWN_TEMPLATES_WITHOUT_FLOWS
      .filter((id) => (templates.find((t) => t.id === id)?.flows ?? []).length > 0);
    expect(stale).toEqual([]);
  });

  it('only tightens: a template that gained evals is off the baseline', () => {
    const stale = KNOWN_TEMPLATES_WITHOUT_EVALS
      .filter((id) => (templates.find((t) => t.id === id)?.evals ?? []).length > 0);
    expect(stale).toEqual([]);
  });

  it('keeps headings in the vocabulary outside the frozen set', () => {
    // Read off the PROSE, not off `sections`: a template that has not been
    // split yet still has the headings, and checking the split view would let
    // an unclassified heading in simply by not splitting the file.
    const off = templates
      .filter((t) => {
        const prose = `${t.responsibilities}\n${t.additionalContext}`;
        return [...prose.matchAll(/^(## .+)$/gm)]
          .some((m) => !(m[1].trim() in SECTION_DESTINATION));
      })
      .map((t) => t.id)
      .filter((id) => !KNOWN_TEMPLATES_WITH_OFF_VOCABULARY_HEADINGS.includes(id));
    expect(off).toEqual([]);
  });

  it('only tightens: a template whose headings were classified is off the baseline', () => {
    const stale = KNOWN_TEMPLATES_WITH_OFF_VOCABULARY_HEADINGS.filter((id) => {
      const t = templates.find((x) => x.id === id);
      if (!t) return false;
      const prose = `${t.responsibilities}\n${t.additionalContext}`;
      return ![...prose.matchAll(/^(## .+)$/gm)]
        .some((m) => !(m[1].trim() in SECTION_DESTINATION));
    });
    expect(stale).toEqual([]);
  });

  // ── The conditional fields ─────────────────────────────────────────────
  //
  // Three more baselines, the same shape, plus the applicability ledger: a
  // template's toolNotes / domainAliases / capabilities are PRESENT, or frozen
  // as debt, or reviewed as not applicable with a reason. Nothing else counts.
  // Without these a template could exit the lane with two promised fields
  // simply absent, and the pilot itself did: domainAliases sat on 0 of 65.

  /** Every capability a template's connector requirements name — the set the
   *  tri-state is required over. */
  const namedCapabilities = (t: { requiredConnectors: Array<{ capability?: string; capabilities?: string[] }>; optionalConnectors?: Array<{ capability?: string; capabilities?: string[] }> }) =>
    [...t.requiredConnectors, ...(t.optionalConnectors ?? [])]
      .flatMap((r) => [r.capability, ...(r.capabilities ?? [])])
      .filter((c): c is string => typeof c === 'string' && c.length > 0);

  const has: Record<ConditionalField, (t: (typeof templates)[number]) => boolean> = {
    toolNotes: (t) => Object.keys(t.toolNotes ?? {}).length > 0,
    domainAliases: (t) => Object.keys(t.domainAliases ?? {}).length > 0,
    // Covered, not merely present: a map that declares two capabilities absent
    // and none of the six the requirements name has not declared its tri-state.
    capabilities: (t) => {
      const named = namedCapabilities(t);
      return named.length > 0 && named.every((c) => (t.capabilities ?? {})[c] !== undefined);
    },
  };
  const baseline: Record<ConditionalField, readonly string[]> = {
    toolNotes: KNOWN_TEMPLATES_WITHOUT_TOOL_NOTES,
    domainAliases: KNOWN_TEMPLATES_WITHOUT_DOMAIN_ALIASES,
    capabilities: KNOWN_TEMPLATES_WITHOUT_CAPABILITIES,
  };
  const FIELDS: ConditionalField[] = ['toolNotes', 'domainAliases', 'capabilities'];

  it.each(FIELDS)('has %s on every template not frozen as debt or reviewed as not applicable', (field) => {
    const missing = templates
      .filter((t) => !has[field](t))
      .map((t) => t.id)
      .filter((id) => !baseline[field].includes(id) && REVIEWED_NOT_APPLICABLE[field][id] === undefined);
    expect(missing).toEqual([]);
  });

  it.each(FIELDS)('only tightens: a template that gained %s is off the baseline', (field) => {
    const stale = baseline[field].filter((id) => {
      const t = templates.find((x) => x.id === id);
      return t !== undefined && has[field](t);
    });
    expect(stale).toEqual([]);
  });

  it.each(FIELDS)('the %s ledger holds only reviewed entries', (field) => {
    for (const [id, reason] of Object.entries(REVIEWED_NOT_APPLICABLE[field])) {
      const t = templates.find((x) => x.id === id);
      // A reason for a template that does not exist reviews nothing.
      expect(t).toBeDefined();
      // One line, and a real one.
      expect(reason.trim().length).toBeGreaterThan(10);
      expect(reason).not.toMatch(/\n/);
      // The review REPLACES the debt entry; the two do not sit side by side.
      expect(baseline[field]).not.toContain(id);
      // A reason for not having something the template now has is stale.
      expect(has[field](t!)).toBe(false);
    }
  });

  it('capabilities are conditional ONLY for a template that names no connector requirement', () => {
    // Wherever requirements name capabilities the tri-state is required over
    // that set, so a ledger entry there is a way round the requirement.
    const wrongly = Object.keys(REVIEWED_NOT_APPLICABLE.capabilities).filter((id) => {
      const t = templates.find((x) => x.id === id);
      return t !== undefined && namedCapabilities(t).length > 0;
    });
    expect(wrongly).toEqual([]);
  });

  it('the code-reviewer pilot carries flows, toolNotes and a paired eval set', () => {
    // A guard on the guard: were the pilot dropped, every assertion above would
    // still pass, on an emptier catalog.
    const cr = templates.find((t) => t.id === 'code-reviewer');
    expect(cr?.flows?.map((f) => f.id)).toEqual(['first-pass-review', 'handle-review-feedback']);
    expect(Object.keys(cr?.toolNotes ?? {})).toEqual(['version_control']);
    // Three cases the plan names, plus the served counterpart that makes the
    // idempotency case mean something.
    expect(cr?.evals?.map((e) => e.id)).toEqual([
      'redelivered-head-reviews-once',
      'new-head-reviews-again',
      'auth-diff-escalates',
      'readme-diff-does-not-escalate',
    ]);
  });
});

describe('validateTemplate still returns the parsed template', () => {
  it('accepts the fixture', () => {
    expect(validateTemplate(BASE).id).toBe('contract-fixture');
  });
});
