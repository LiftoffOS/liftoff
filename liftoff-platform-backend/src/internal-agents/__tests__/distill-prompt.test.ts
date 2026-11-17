// Locks down the structural shape of the distill system prompt + trigger
// config schema. Diffs surface every prompt edit at review time so silent
// drift is impossible.
//
// The four sections checked here are the trigger-primitive sections of the
// prompt. If a future edit touches them and these tests fail, regenerate the
// assertions and describe the intent in the PR.

// Mock the transitive imports that distill-service drags in so this test can
// load it without resolving the proto-gen package (path mapping fails inside
// worktrees). The mocks are not exercised — the test only reads pure constants.
jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getTenantManifests: jest.fn(),
    getToolCatalog: jest.fn(),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../distill-cache', () => ({
  computePriorArtHash: jest.fn().mockReturnValue(''),
  computeCatalogHash: jest.fn(),
  computeFingerprint: jest.fn(),
  getCachedDistillation: jest.fn(),
  setCachedDistillation: jest.fn(),
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  resetCatalogCache: jest.fn(),
}));

import {
  __internalGetPromptText,
  __internalGetTriggerConfigSchema,
  __internalGetInstructionsMdDesc,
  __internalWavedInternals,
} from '../distill-service';

describe('DISTILL_SYSTEM_PROMPT — Per-record deadlines (§3.1)', () => {
  const prompt = __internalGetPromptText();

  it('contains the "Per-record deadlines (data-shape-driven)" section header', () => {
    expect(prompt).toContain('## Per-record deadlines (data-shape-driven)');
  });

  it('contains Case (a), (b), and (c) subsection headers', () => {
    expect(prompt).toContain('### Case (a): Entity-store deadlines — use a daily companionCron with date-range predicates');
    expect(prompt).toContain('### Case (b): Event-keyed deadlines — use schedule_followup');
    expect(prompt).toContain('### Case (c): Mixed — don\'t');
  });

  it('teaches milestone-suffixed context_ref for multi-deadline sequences', () => {
    expect(prompt).toMatch(/MULTIPLE SEQUENTIAL deadlines on the same entity:.*suffix the milestone/);
    expect(prompt).toContain('context_ref = "lead_${id}_touch_2"');
  });

  it('teaches business-day weekday math explicitly with all three firing-day examples', () => {
    expect(prompt).toContain('### Business-day math is the skill\'s responsibility');
    expect(prompt).toContain('Firing on Wednesday → +2 business days = Friday');
    expect(prompt).toContain('Firing on Thursday → +2 business days = Monday');
    expect(prompt).toContain('Firing on Friday → +2 business days = Tuesday');
  });

  it('removes the actively-misleading "Day-1 / Day-7 / Day-14 keyed by employee id" example', () => {
    expect(prompt).not.toContain('three schedule_followup calls keyed by employee id');
  });

  it('removes the cancel-less "Touch 2 in 4 business days" example', () => {
    expect(prompt).not.toContain('with the touch number encoded in the objective');
  });
});

describe('TRIGGER_CONFIG_SCHEMA — decision-tree primer (§3.4)', () => {
  const schema = __internalGetTriggerConfigSchema();
  const description = (schema as { description: string }).description;

  it('appends the CHOOSING A SECONDARY PRIMITIVE decision tree', () => {
    expect(description).toContain('CHOOSING A SECONDARY PRIMITIVE — decision tree');
  });

  it('lists all five decision-tree branches (companionCron / cron+date-range / schedule_followup / reactiveSubscription / workflow delay)', () => {
    expect(description).toMatch(/1\. Agent-wide recurring work/);
    expect(description).toMatch(/2\. Per-record deadline derived from a durable connector field/);
    expect(description).toMatch(/3\. Per-record deadline keyed to a transient event/);
    expect(description).toMatch(/4\. Reaction to a connector state change matching a predicate/);
    expect(description).toMatch(/5\. Workflow-step delay inside a deterministic workflow agent/);
  });

  it('closes with the "pick exactly one" mixing prohibition', () => {
    expect(description).toContain('When two primitives could plausibly fit');
    expect(description).toContain('pick exactly one');
  });
});

describe('TRIGGER_CONFIG_SCHEMA — reactiveSubscriptions FORWARD-ONLY + persistent-breach (§3.2)', () => {
  const schema = __internalGetTriggerConfigSchema();
  type SchemaWithProps = { properties: { reactiveSubscriptions: { description: string } } };
  const reactiveDesc = (schema as unknown as SchemaWithProps).properties.reactiveSubscriptions.description;

  it('contains the FORWARD-ONLY paragraph (no backfill, no replay)', () => {
    expect(reactiveDesc).toContain('FORWARD-ONLY');
    expect(reactiveDesc).toContain('no backfill');
    expect(reactiveDesc).toContain('emitted AFTER the subscription is created');
  });

  it('contains the PERSISTENT-BREACH SEMANTICS paragraph with cooldown caveat', () => {
    expect(reactiveDesc).toContain('PERSISTENT-BREACH SEMANTICS');
    expect(reactiveDesc).toContain('fire ONCE PER COOLDOWN');
    expect(reactiveDesc).toContain('CLEAR the breach condition');
  });
});

describe('TRIGGER_CONFIG_SCHEMA — cooldownSeconds description (§3.3)', () => {
  const schema = __internalGetTriggerConfigSchema();
  type CooldownPath = {
    properties: {
      reactiveSubscriptions: {
        items: { properties: { cooldownSeconds: { description: string } } };
      };
    };
  };
  const cooldownDesc = (schema as unknown as CooldownPath)
    .properties.reactiveSubscriptions.items.properties.cooldownSeconds.description;

  it('expands beyond the original six-word description', () => {
    expect(cooldownDesc).not.toBe('Suppress re-fire for this long. Default 60.');
    expect(cooldownDesc.length).toBeGreaterThan(200);
  });

  it('explains per-(subscription, entity_id) scope', () => {
    expect(cooldownDesc).toContain('per-(subscription, entity_id)');
  });

  it('warns about persistent-state predicates firing indefinitely without a clearing action', () => {
    expect(cooldownDesc).toContain('persistent-state predicates');
    expect(cooldownDesc).toContain('flips the predicate to false');
  });
});

describe('DISTILL_SYSTEM_PROMPT — skill-authoring exemplars (Change 1)', () => {
  const prompt = __internalGetPromptText();

  it('includes the skill exemplars section', () => {
    expect(prompt).toContain('Skill authoring exemplars');
  });

  it('carries concrete connector/field-specific exemplars, not generic titles', () => {
    expect(prompt).toContain('Reviewing pull requests');
    expect(prompt).toContain('Writing an incident postmortem');
    // Each exemplar description is a "Use when …" semantic anchor.
    expect(prompt).toContain('Use when a PR URL or diff is provided');
  });

  it('every exemplar description carries a negative boundary naming a sibling', () => {
    // An exemplar is the densest instruction in the prompt: the model copies its
    // SHAPE. One without a boundary teaches that a trigger alone is a complete
    // retrieval key, which is the shape skills fall into by default.
    const exemplarDescriptions = [...prompt.matchAll(/"description": "([^"]+)"/g)]
      .map(m => m[1])
      .filter(d => d.startsWith('Use when'));

    expect(exemplarDescriptions.length).toBeGreaterThanOrEqual(2);
    for (const description of exemplarDescriptions) {
      expect(description).toContain('Not needed for');
      expect(description).toMatch(/\(that is [^)]+\)/);
    }
  });
});

describe('produce_agent skills schema — the negative boundary', () => {
  const fields = __internalWavedInternals.produceAgentFields('tenant-abc');
  const skills = fields.skills;
  const descriptionField = skills.items?.properties?.description;

  it('requires the boundary clause on each skill description', () => {
    expect(descriptionField?.description).toContain('Use when [exact trigger].');
    expect(descriptionField?.description).toContain('Not needed for [neighbouring request class]');
    expect(descriptionField?.description).toContain('(that is <sibling skill name>)');
  });

  it('forbids sample utterances as the retrieval key', () => {
    // The key has to name the request CLASS: a quoted utterance matches the one
    // phrasing it quotes and nothing a person would actually type.
    expect(descriptionField?.description).toMatch(/never a sample utterance/i);
  });

  it('says what to write when no sibling is close enough to name', () => {
    // Without this the model has no legal move for a single-skill agent and
    // either invents a sibling or drops the clause.
    expect(descriptionField?.description).toContain('nearest neighbouring');
  });

  it('states the same two-clause rule in the array-level guidance', () => {
    // The array description and the item description are read together. Leaving
    // the array half saying "one sentence" contradicts the item half, and the
    // model followed the schema over the prose the last time the two disagreed.
    expect(skills.description).toContain('TWO clauses');
    expect(skills.description).toContain('Not needed for');
    expect(skills.description).not.toContain('One sentence beginning with "Use when"');
  });
});

describe('DISTILL_SYSTEM_PROMPT — calibrate numeric cutoffs (Change 3, prompt-only)', () => {
  const prompt = __internalGetPromptText();

  it('instructs the model to state cutoffs as calibrated defaults in prose', () => {
    expect(prompt).toContain('STEP 3 — Calibrate numeric cutoffs');
    expect(prompt).toContain('calibrated default');
  });

  it('does NOT reintroduce the withdrawn thresholds config primitive', () => {
    // The {{threshold:key}} indirection + thresholds[] field were backed out;
    // this locks the prompt to the invisible prose-only nudge.
    expect(prompt).not.toContain('{{threshold:');
    expect(prompt).not.toContain('thresholds[]');
  });
});

describe('instructionsMd schema — contrastive gotchas (Change 2)', () => {
  const desc = __internalGetInstructionsMdDesc('tenant-abc');

  it('tells the model to preserve do/don\'t guidance as contrastive pairs', () => {
    expect(desc).toContain('Pitfalls and gotchas');
    expect(desc).toContain('contrastive pair');
    expect(desc).toContain('❌');
    expect(desc).toContain('✅');
  });
});
