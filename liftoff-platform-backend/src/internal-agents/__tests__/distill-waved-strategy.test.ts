// The waved distillation strategy's structural invariants.
//
// These are the properties the split cannot check for itself at runtime. A
// field left out of BRANCH_FIELDS is never generated, and the merged artifact
// that results is well-formed, passes every validator, and is quietly missing
// something — which is precisely how the first implementation of this shipped
// with three of the schema's eleven fields unassigned.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { __internalWavedInternals, __internalGetProduceAgentToolText } from '../distill-service';

const TENANT = '00000000-0000-0000-0000-000000000000';

describe('BRANCH_FIELDS partitions the produce_agent schema', () => {
  it('assigns every field the single-call schema declares', () => {
    const schemaFields = Object.keys(
      (JSON.parse(__internalGetProduceAgentToolText()) as {
        input_schema: { properties: Record<string, unknown> };
      }).input_schema.properties,
    ).sort();

    const assigned = Object.values(__internalWavedInternals.BRANCH_FIELDS())
      .flat()
      .sort();

    // Set equality both ways. A field in the schema but not in a branch is
    // never produced; a field in a branch but not in the schema would build a
    // tool with an undefined property.
    expect(assigned).toEqual(schemaFields);
  });

  it('assigns each field to exactly one branch', () => {
    const assigned = Object.values(__internalWavedInternals.BRANCH_FIELDS()).flat();
    // Two branches emitting the same field would race in the merge, and which
    // one won would depend on wave ordering rather than on anything meaningful.
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('every branch tool is a real subset of the single-call schema', () => {
    const single = JSON.parse(__internalGetProduceAgentToolText()) as {
      input_schema: { properties: Record<string, unknown>; required: string[] };
    };

    for (const branch of Object.keys(__internalWavedInternals.BRANCH_FIELDS()) as Array<
      'summary' | 'system_prompt' | 'graph' | 'capability' | 'user_instructions' | 'instructions_md' | 'skills'
    >) {
      const tool = __internalWavedInternals.buildBranchTool(branch, TENANT);
      expect(tool.name).toBe('produce_agent');

      for (const [field, schema] of Object.entries(tool.input_schema.properties ?? {})) {
        const mine = JSON.parse(JSON.stringify(schema))
        const theirs = single.input_schema.properties[field] as Record<string, unknown>

        // The anti-drift guarantee is about WORDING: every description the model
        // reads must be the one the single call reads, or the comparison
        // measures the wording rather than the split. Asserted directly rather
        // than via whole-object equality, because a strict branch legitimately
        // differs in structure.
        expect(mine.description).toEqual(theirs.description)

        // A non-strict branch must still match exactly. Strict branches may
        // differ ONLY by the keywords Anthropic forbids under strict and the
        // closure it requires — anything else would be real drift hiding behind
        // the exemption, so the difference is enumerated rather than waved past.
        if (!tool.strict) {
          expect(mine).toEqual(theirs)
        } else {
          const strip = (o: unknown): unknown => {
            if (Array.isArray(o)) return o.map(strip)
            if (o && typeof o === 'object') {
              const out: Record<string, unknown> = {}
              for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
                if (['maxItems', 'minItems', 'maxLength', 'minLength', 'additionalProperties'].includes(k)) continue
                out[k] = strip(v)
              }
              return out
            }
            return o
          }
          expect(strip(mine)).toEqual(strip(theirs))
        }
      }

      // A field optional in the single arm must not become mandatory here.
      for (const required of tool.input_schema.required ?? []) {
        expect(single.input_schema.required).toContain(required);
      }
    }
  });
});

describe('branchesImplicatedBy', () => {
  const all = ['summary', 'system_prompt', 'graph', 'capability', 'user_instructions', 'instructions_md', 'skills'];

  it('re-runs everything when the feedback names nothing recognisable', () => {
    // Conservative on ambiguity: a stale field silently kept is worse than a
    // redundant call.
    expect([...__internalWavedInternals.branchesImplicatedBy('something went wrong')].sort())
      .toEqual([...all].sort());
  });

  it('re-runs only the branch a named field belongs to', () => {
    const implicated = __internalWavedInternals.branchesImplicatedBy(
      'distill: instructionsMd missing from LLM output',
    );
    expect(implicated.has('instructions_md')).toBe(true);
    expect(implicated.has('summary')).toBe(false);
    expect(implicated.has('skills')).toBe(false);
  });

  it('treats a rejection quoting a step as a rejection of the graph', () => {
    // The workflow validators name step ids far more often than they name the
    // field, so matching on the field name alone would miss most of them.
    const implicated = __internalWavedInternals.branchesImplicatedBy(
      'Step "s2": MISSING required: user_id',
    );
    expect(implicated.has('graph')).toBe(true);
  });

  it('does not carry the step-dependent branches with a merely re-run graph', () => {
    // They are written against the STEPS, and a re-run graph usually returns
    // the steps it just produced: most graph rejections name one step's
    // arguments and the repair leaves the rest of the array alone. Adding them
    // here, before the graph has run, would pay for the two most expensive
    // branches in the pipeline on the chance that anything changed. The
    // invalidation happens after the graph lands, where "did the steps
    // change?" is a fact rather than a guess.
    const implicated = __internalWavedInternals.branchesImplicatedBy('workflowSteps rejected');
    expect(implicated.has('graph')).toBe(true);
    expect(implicated.has('skills')).toBe(false);
    expect(implicated.has('user_instructions')).toBe(false);
    expect(implicated.has('instructions_md')).toBe(false);
  });
});

// ── Branch briefs ───────────────────────────────────────────────────────────
//
// The first real waved run failed on both inputs, identically: the graph branch
// omitted the required `triggerConfig` on all three attempts. The cause was not
// the tool — that was correctly scoped — but the prompt, which still ended by
// telling every branch to "generate the summary, system prompt, user
// instructions, and instructionsMd" while handing it a tool that accepts none
// of them. Scoping tools without scoping prompts is the defect these pin.

describe('branch user messages are scoped to the branch', () => {
  const SHARED = `ROLE: Analyst\n\nRESPONSIBILITIES:\nDo the thing.\n\n${
    __internalWavedInternals.WHOLE_ARTIFACT_CLOSING()}`

  it('drops the whole-artifact closing instruction', () => {
    for (const branch of Object.keys(__internalWavedInternals.BRANCH_FIELDS()) as Array<
      'summary' | 'system_prompt' | 'graph' | 'capability' | 'user_instructions' | 'instructions_md' | 'skills'
    >) {
      const msg = __internalWavedInternals.buildBranchUserMessage(branch, SHARED)
      expect(msg).not.toContain(__internalWavedInternals.WHOLE_ARTIFACT_CLOSING())
    }
  })

  it('keeps the context above the closing, which the branch needs', () => {
    const msg = __internalWavedInternals.buildBranchUserMessage('graph', SHARED)
    // Stripping the context would trade one failure mode for a worse one: a
    // branch cannot get its own field right without the role it is for.
    expect(msg).toContain('ROLE: Analyst')
    expect(msg).toContain('Do the thing.')
  })

  it('names exactly the fields the branch tool accepts', () => {
    const fields = __internalWavedInternals.BRANCH_FIELDS()
    for (const branch of Object.keys(fields) as Array<'summary' | 'graph' | 'skills'>) {
      const msg = __internalWavedInternals.buildBranchUserMessage(branch, SHARED)
      for (const f of fields[branch]) expect(msg).toContain(f)
    }
  })

  it('tells the graph branch the trigger is required even with no graph', () => {
    // The conversational case failed hardest: told a role needs no
    // workflowSteps, the model emitted nothing at all — including the trigger,
    // which is required either way.
    const msg = __internalWavedInternals.buildBranchUserMessage('graph', SHARED)
    expect(msg).toMatch(/triggerConfig is REQUIRED whether or not there is a graph/i)
  })

  it('appends the wave-2 seed after the directive, not before it', () => {
    // Recency: the directive is what the model acts on, and the seed is context
    // for it. Reversed, the last thing read is a graph dump.
    // Seed is the FOURTH argument; the third is the tenant, which the caps are
    // read against. Passing it positionally in the wrong slot is exactly the
    // silent reinterpretation this assertion caught when the signature changed.
    const msg = __internalWavedInternals.buildBranchUserMessage('skills', SHARED, TENANT, 'SEED-MARKER')
    expect(msg.indexOf('SEED-MARKER')).toBeGreaterThan(msg.indexOf('produce_agent tool accepts'))
  })

  it('names the required fields explicitly and allows negative answers', () => {
    // "Emit whatever the schema marks required" was not enough. On a 34-character
    // conversational role the model answered minimally and simply left
    // capabilityNeeds out — an omission is not the same as declaring "no
    // workspace needed", but to a model in minimal mode it looks the same.
    const msg = __internalWavedInternals.buildBranchUserMessage('graph', SHARED)
    expect(msg).toContain('YOU MUST INCLUDE THESE FIELDS: triggerConfig')
    expect(msg).toMatch(/negative, empty or obvious/i)
  })
})

describe('the capability branch is enforced, not asked', () => {
  it('is the only strict branch, and closes its schema', () => {
    // Every other branch's schema uses oneOf, maxItems or maxLength somewhere,
    // all of which Anthropic rejects under strict. Dismantling them to qualify
    // would remove constraints that are load-bearing, so only the branch that
    // actually qualifies opts in.
    for (const branch of Object.keys(__internalWavedInternals.BRANCH_FIELDS()) as Array<
      'summary' | 'system_prompt' | 'graph' | 'capability' | 'user_instructions' | 'instructions_md' | 'skills'
    >) {
      const tool = __internalWavedInternals.buildBranchTool(branch, TENANT)
      if (branch === 'capability') {
        expect(tool.strict).toBe(true)
        expect(tool.input_schema.additionalProperties).toBe(false)
      } else {
        expect(tool.strict).toBeUndefined()
      }
    }
  })

  it('carries no keyword strict mode rejects', () => {
    // Verified against the live API: maxItems and oneOf are both 400s. A regression
    // here would not fail loudly at build time — it would fail every distillation.
    const tool = __internalWavedInternals.buildBranchTool('capability', TENANT)
    const json = JSON.stringify(tool.input_schema)
    for (const banned of ['maxItems', 'minItems', 'maxLength', 'minLength', 'oneOf']) {
      expect(json).not.toContain(banned)
    }
  })

  it('no longer burdens the graph branch with it', () => {
    // A graph branch that also owns capabilityNeeds can drop it, even through
    // correction turns that name the field.
    expect(__internalWavedInternals.BRANCH_FIELDS().graph).not.toContain('capabilityNeeds')
    expect(__internalWavedInternals.BRANCH_FIELDS().capability).toEqual(['capabilityNeeds'])
  })
})

describe('length caps reach the branch', () => {
  it('states each capped field and its limit', () => {
    // maxLength is advisory to the model — Anthropic enforces it only under
    // strict mode, which this schema cannot use. The single call stays inside
    // its caps; a branch that is not told the limit overruns the
    // userInstructions cap, because it holds the whole budget alone.
    const msg = __internalWavedInternals.buildBranchUserMessage(
      'user_instructions', 'ROLE: X\n\n', TENANT)
    expect(msg).toMatch(/LENGTH LIMITS, which are hard/)
    expect(msg).toContain('userInstructions at most 8000 characters')
  })

  it('says nothing about limits for a branch whose fields have none', () => {
    // workflowSteps is bounded by maxItems, not maxLength. Inventing a
    // character limit for it would be a constraint the schema never set.
    const msg = __internalWavedInternals.buildBranchUserMessage('graph', 'ROLE: X\n\n', TENANT)
    expect(msg).not.toMatch(/LENGTH LIMITS/)
  })
})

describe('a workspace rejection is a rejection of the prose', () => {
  // Wording lifted from findCapabilityViolations, so this test fails if the
  // validator's phrasing changes out from under the matcher.
  const WORKSPACE_FEEDBACK =
    'instructionsMd references the workspace tool "shell_exec" while '
    + '`capabilityNeeds.workspace` is false, so the agent will not have it.'

  it('holds the capability decision and re-runs the prose instead', () => {
    // Left to itself the split resolves this rejection by GRANTING the
    // workspace, because the feedback names capabilityNeeds and so re-runs the
    // branch that owns it. The single call resolves it by dropping the tool
    // reference. The decision is the authority; the prose complies.
    const implicated = __internalWavedInternals.branchesImplicatedBy(WORKSPACE_FEEDBACK)
    expect(implicated.has('capability')).toBe(false)
    expect(implicated.has('instructions_md')).toBe(true)
  })

  it('does not reopen the decision on a later attempt either', () => {
    // The escape hatch this replaces is where the last over-grant came from.
    // Reopened on a retry, the branch granted a workspace because "the agent's
    // instructionsMd already dispatches shell_exec" — the rejected reference
    // citing itself as justification. A genuine need stays reachable through
    // the branch's first pass, which is decided before any prose exists.
    const implicated = __internalWavedInternals.branchesImplicatedBy(WORKSPACE_FEEDBACK)
    expect(implicated.has('capability')).toBe(false)
  })

  it('leaves other capability feedback free to re-run the decision', () => {
    const implicated = __internalWavedInternals.branchesImplicatedBy(
      'capabilityNeeds is missing a reasoning sentence')
    expect(implicated.has('capability')).toBe(true)
  })
})

describe('branchFieldCaps reads the schema, never a copy of it', () => {
  it('reports userInstructions at the cap the schema declares', () => {
    const caps = __internalWavedInternals.branchFieldCaps('user_instructions')
    const schema = __internalWavedInternals.produceAgentFields(TENANT)
      .userInstructions as { maxLength?: number }
    expect(caps).toEqual([{ field: 'userInstructions', maxLength: schema.maxLength }])
  })

  it('reports nothing for a branch whose fields declare no maxLength', () => {
    // Not "no cap of 0" — no entry at all, so the directive stays silent rather
    // than inventing a limit the schema never set.
    expect(__internalWavedInternals.branchFieldCaps('graph')).toEqual([])
  })

  it('covers every capped field of a multi-field branch', () => {
    // A branch owning several fields must enforce all their caps, not the first.
    const fields = __internalWavedInternals.produceAgentFields(TENANT)
    for (const branch of Object.keys(__internalWavedInternals.BRANCH_FIELDS())) {
      const owned = __internalWavedInternals.BRANCH_FIELDS()[
        branch as keyof ReturnType<typeof __internalWavedInternals.BRANCH_FIELDS>]
      const expected = owned
        .filter((f) => typeof (fields[f] as { maxLength?: number }).maxLength === 'number')
        .map((f) => ({ field: f, maxLength: (fields[f] as { maxLength: number }).maxLength }))
      expect(__internalWavedInternals.branchFieldCaps(
        branch as Exclude<Parameters<typeof __internalWavedInternals.buildBranchTool>[0], never>))
        .toEqual(expected)
    }
  })
})

describe('the graph branch is not handed permission to skip', () => {
  const note = () => __internalWavedInternals.buildBranchUserMessage('graph', 'ROLE: X\n\n', TENANT)

  it('still requires a trigger whether or not there is a graph', () => {
    // The original failure: told a role was conversational, the branch emitted
    // nothing at all, including the trigger every agent needs.
    expect(note()).toMatch(/triggerConfig is REQUIRED whether or not there is a graph/)
  })

  it('does not tell the branch that omitting workflowSteps is correct', () => {
    // The opposite failure: given that sentence, the branch omits the graph
    // where the single call emits a real procedure for the same role. Deciding
    // in isolation off the role line, permission to skip is the only push it
    // needs.
    expect(note()).not.toMatch(/omitting it is correct/)
    expect(note()).toMatch(/judge by the WORK, not by the role line/)
    expect(note()).toMatch(/no other call\s+emits one/)
  })
})

describe('the capability branch is given the standard it has to meet', () => {
  const note = () =>
    __internalWavedInternals.buildBranchUserMessage('capability', 'ROLE: X\n\n', TENANT)

  it('states the default and puts the burden on granting', () => {
    // A call whose entire job is one yes/no question skews toward yes: the
    // branch tends to answer "workspace" where the single call, weighing the
    // same question among ten fields, answers no.
    expect(note()).toMatch(/The answer is `false` unless something specific forces `true`/)
  })

  it('rules out the two signals a branch tends to reason from', () => {
    // Both are signals a branch reasons from: the role title before it can
    // see anything else, the workflow graph once it can.
    expect(note()).toMatch(/ROLE TITLE is not/)
    expect(note()).toMatch(/WORKFLOW GRAPH is not/)
  })

  it('makes a grant checkable by requiring a named operation', () => {
    expect(note()).toMatch(/name in `reasoning` the specific operation/)
  })

  it('does not leak the capability note into other branches', () => {
    for (const b of ['graph', 'skills', 'summary', 'user_instructions'] as const) {
      expect(__internalWavedInternals.buildBranchUserMessage(b, 'ROLE: X\n\n', TENANT))
        .not.toMatch(/burden\s+is on granting/)
    }
  })
})

describe('the equipment decision precedes every branch that can name a tool', () => {
  it('binds the graph branch, not only the prose branches', () => {
    // The cascade moved rather than closing when only wave 2 was bound: the
    // graph ran in wave 1, ahead of the decision, and a step naming shell_exec
    // forced the grant exactly as prose naming it had. The capability branch
    // said so itself — "workflow step s3 and instructionsMd both name
    // shell_exec, so the agent as designed executes local commands".
    const withEquipment = __internalWavedInternals.buildBranchUserMessage(
      'graph', 'ROLE: X\n\n', TENANT, 'EQUIPMENT, ALREADY DECIDED: this agent has NO workspace.')
    expect(withEquipment).toMatch(/EQUIPMENT, ALREADY DECIDED/)
    // And it arrives last, where the model acts on it.
    expect(withEquipment.indexOf('EQUIPMENT, ALREADY DECIDED'))
      .toBeGreaterThan(withEquipment.indexOf('produce_agent tool accepts'))
  })
})
