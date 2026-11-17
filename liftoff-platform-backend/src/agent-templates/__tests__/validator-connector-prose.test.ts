// `{{connector:<id>}}` — one instruction, chosen at hire.
//
// A template used to carry the connected version in the workflow and the
// unconnected version in an edge case, and a hired team got both: an
// instruction to post to a channel, plus a paragraph about what to do when
// there is no channel. We know at hire which it is, so the agent should read
// one clause and evaluate no branch.
//
// These pin the rules that make that safe. Every one of them exists because
// without it a destination, or a dangling reference, survives into a team that
// has no such connector.

jest.mock('../../connectors/connector-service-client', () => ({}));
jest.mock('../../connectors/connector-service-cache', () => ({}));

import { agentTemplateZodSchema } from '../validator';

const OPT = {
  id: 'opt-team-chat',
  connectorType: 'slack',
  role: 'tool',
  description: 'Post the alert',
  objects: [{
    id: 'alert-channel', kind: 'channel', direction: 'write',
    label: 'Where should the alert go?', required: false, fallback: 'your team channel',
  }],
  prose: {
    whenBound: 'post it to {{pick:alert-channel}}',
    whenUnbound: 'include it in your written output',
  },
};

function template(over: Record<string, unknown> = {}) {
  return {
    id: 'prose-variant-test',
    displayName: 'Prose Variant Test',
    departmentCategory: 'operations',
    description: 'description',
    roleSummary: 'roleSummary',
    role: 'Prose Variant Test',
    responsibilities: '## Responsibilities\nProduce the thing, and {{connector:opt-team-chat}}.',
    additionalContext: '## Rules\nbar',
    requiredConnectors: [{ id: 'req-docs', connectorType: 'google_drive', role: 'tool', description: 'd' }],
    optionalConnectors: [OPT],
    defaultAgentType: 'agent',
    defaultMemoryScope: {},
    defaultTriggerConfig: { type: 'manual' },
    schemaVersion: 1,
    ...over,
  };
}

const err = (r: { error?: { issues: unknown } }) => JSON.stringify(r.error?.issues ?? '');

it('accepts a template whose clause is chosen at hire', () => {
  expect(agentTemplateZodSchema.safeParse(template()).success).toBe(true);
});

it('rejects a reference to a connector that is required, not optional', () => {
  // A required connector is always bound, so there is no second version to
  // choose between and the reference would be dead syntax.
  const r = agentTemplateZodSchema.safeParse(template({
    responsibilities: '## Responsibilities\nDo it, and {{connector:req-docs}}.',
  }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/not a declared OPTIONAL connector/);
});

it('rejects a reference to a connector with no variants declared', () => {
  // Unresolved, the reference resolves to nothing and the sentence loses its verb.
  const { prose: _p, ...noProse } = OPT;
  const r = agentTemplateZodSchema.safeParse(template({ optionalConnectors: [noProse] }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/declares no prose variants/);
});

it('rejects variants nothing references', () => {
  const r = agentTemplateZodSchema.safeParse(template({
    responsibilities: '## Responsibilities\nProduce the thing.',
  }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/variants that nothing references/);
});

it('rejects a destination named in the clause for NOT having that connector', () => {
  // It would resolve to a phrase describing a channel the team was never given.
  const r = agentTemplateZodSchema.safeParse(template({
    optionalConnectors: [{
      ...OPT,
      prose: { whenBound: 'post it to {{pick:alert-channel}}', whenUnbound: 'post it to {{pick:alert-channel}}' },
    }],
  }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/must read as though that tool was never part of the job/);
});

it('rejects the destination left loose in the body prose', () => {
  // This is the hole the mechanism closes: outside the whenBound clause the
  // pick survives into a hired team with no such connector.
  const r = agentTemplateZodSchema.safeParse(template({
    responsibilities: '## Responsibilities\nProduce it and post to {{pick:alert-channel}}, and {{connector:opt-team-chat}}.',
  }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/Move it inside that connector's whenBound clause/);
});

it('still allows a pick on a REQUIRED connector to sit in the body prose', () => {
  // A required connector is always there, so its destination needs no variant.
  const r = agentTemplateZodSchema.safeParse(template({
    requiredConnectors: [{
      id: 'req-docs', connectorType: 'google_drive', role: 'tool', description: 'd',
      objects: [{ id: 'working-folder', kind: 'folder', direction: 'write', label: 'Where?', required: false, fallback: 'your working folder' }],
    }],
    responsibilities: '## Responsibilities\nWrite it to {{pick:working-folder}}, and {{connector:opt-team-chat}}.',
  }));
  expect(r.success).toBe(true);
});

it('rejects a destination on an optional connector that does not use variants', () => {
  // The rule that closes the conversion window: a bare pick on an optional
  // connector resolves to its fallback phrase whether or not the connector was
  // bound, so a team with no team chat is told to post to "your team channel".
  const { prose: _p, ...noVariants } = OPT;
  const r = agentTemplateZodSchema.safeParse(template({
    optionalConnectors: [noVariants],
    responsibilities: '## Responsibilities\nProduce it and post to {{pick:alert-channel}}.',
  }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/owns a destination named directly in the prose/);
});

it('leaves an optional connector with no destinations alone', () => {
  // Plenty of optional connectors are pure reads with nothing to name. They
  // need no variants, and requiring them would be noise.
  const r = agentTemplateZodSchema.safeParse(template({
    optionalConnectors: [{ id: 'opt-crm', connectorType: 'hubspot', role: 'data_source', description: 'Read deals' }],
    responsibilities: '## Responsibilities\nProduce the thing.',
  }));
  expect(r.success).toBe(true);
});
