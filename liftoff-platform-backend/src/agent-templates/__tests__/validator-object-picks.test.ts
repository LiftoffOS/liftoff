// What one requirement's picker can actually answer.
//
// A requirement opens exactly one modal, and ObjectPicker resolves its kind
// from the first declared object. A tree browses folders and files together and
// routes each row to the pick its kind answers; a flat list answers the one
// pick it was opened for. Anything else on the same requirement is simply never
// rendered — no error, no empty state, nothing in the console. The template
// reads as though the person named a second destination, and they were never
// shown the question.
//
// These rules move that from a trap an author has to know about to a failure at
// catalog load.

jest.mock('../../connectors/connector-service-client', () => ({}));
jest.mock('../../connectors/connector-service-cache', () => ({}));

import { agentTemplateZodSchema } from '../validator';

type Obj = { id: string; kind: string; direction: string; label: string; required: boolean };

const obj = (id: string, kind: string, direction = 'write'): Obj =>
  ({ id, kind, direction, label: `pick ${id}`, required: true });

function withObjects(objects: Obj[]) {
  return {
    id: 'pick-shape-test',
    displayName: 'X',
    departmentCategory: 'operations',
    description: 'description',
    roleSummary: 'roleSummary',
    role: 'role',
    responsibilities: '## Responsibilities\nfoo',
    additionalContext: '## Rules\nbar',
    requiredConnectors: [
      { id: 'req-docs', connectorType: 'google_drive', role: 'tool', description: 'd', objects },
    ],
    optionalConnectors: [],
    defaultAgentType: 'agent',
    defaultMemoryScope: {},
    defaultTriggerConfig: { type: 'manual' },
    schemaVersion: 1,
  };
}

const issues = (result: { success: boolean; error?: { issues: unknown } }) =>
  result.success ? '' : JSON.stringify(result.error!.issues);

describe('requirement objects — what one picker can answer', () => {
  it('accepts a folder and a file together, which one tree answers in a single pass', () => {
    const result = agentTemplateZodSchema.safeParse(
      withObjects([obj('working-folder', 'folder'), obj('clause-library', 'file', 'read')]),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a lone channel', () => {
    const result = agentTemplateZodSchema.safeParse(withObjects([obj('alert-channel', 'channel')]));
    expect(result.success).toBe(true);
  });

  it('rejects a channel beside a folder, because one modal cannot be a tree and a list', () => {
    const result = agentTemplateZodSchema.safeParse(
      withObjects([obj('working-folder', 'folder'), obj('alert-channel', 'channel')]),
    );
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/split them across requirements/i);
  });

  it('rejects a channel beside a folder in the other order too', () => {
    // The flat kind first is the worse of the two: the tree never renders at
    // all, so a required folder pick silently cannot be answered.
    const result = agentTemplateZodSchema.safeParse(
      withObjects([obj('alert-channel', 'channel'), obj('working-folder', 'folder')]),
    );
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/split them across requirements/i);
  });

  it('rejects two channels, since the flat picker answers the first only', () => {
    const result = agentTemplateZodSchema.safeParse(
      withObjects([obj('alert-channel', 'channel'), obj('summary-channel', 'channel')]),
    );
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/would never be shown/i);
  });

  it('rejects two folders, since a row is routed by its kind and cannot say which pick it answers', () => {
    const result = agentTemplateZodSchema.safeParse(
      withObjects([obj('drafts-folder', 'folder'), obj('archive-folder', 'folder')]),
    );
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/two folder picks/i);
  });

  it('rejects two destinations ACROSS requirements, which one picker rule cannot see', () => {
    // The per-requirement rule refuses two on one picker. This is the level that
    // matters downstream: the picks are read as one set keyed by object id, so
    // two destinations are two answers to one question and only one reaches the
    // team's prose, the distillation prompt and the graph fence.
    const t = {
      ...withObjects([obj('working-folder', 'destination')]),
      requiredConnectors: [
        { id: 'req-docs', connectorType: 'google_drive', role: 'tool', description: 'd',
          objects: [obj('working-folder', 'destination')] },
        { id: 'req-sheets', connectorType: 'google_sheets', role: 'tool', description: 'd',
          objects: [obj('report-doc', 'destination')] },
      ],
    };
    const result = agentTemplateZodSchema.safeParse(t);
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/destinations across its requirements/i);
  });

  it('accepts one destination beside picks of every other kind', () => {
    const t = {
      ...withObjects([obj('working-folder', 'destination')]),
      requiredConnectors: [
        { id: 'req-docs', connectorType: 'google_drive', role: 'tool', description: 'd',
          objects: [obj('working-folder', 'destination')] },
        { id: 'req-chat', connectorType: 'slack', role: 'tool', description: 'd',
          objects: [obj('alert-channel', 'channel')] },
      ],
    };
    expect(agentTemplateZodSchema.safeParse(t).success).toBe(true);
  });

  it('rejects a required pick on an optional connector', () => {
    // A connection exists because somebody connected it once, not because this
    // team was asked to use it, so an optional requirement must never be able
    // to hold the hire through a pick.
    const t = {
      ...withObjects([]),
      requiredConnectors: [],
      optionalConnectors: [
        { id: 'opt-chat', connectorType: 'slack', role: 'tool', description: 'd', objects: [
          { id: 'alert-channel', kind: 'channel', direction: 'write', required: true, label: 'l', fallback: 'your team channel' },
        ] },
      ],
    };
    const result = agentTemplateZodSchema.safeParse(t);
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/optional connector cannot make anything required/i);
  });

  it('accepts the same pick when it is not required', () => {
    const t = {
      ...withObjects([]),
      requiredConnectors: [],
      optionalConnectors: [
        { id: 'opt-chat', connectorType: 'slack', role: 'tool', description: 'd', objects: [
          { id: 'alert-channel', kind: 'channel', direction: 'write', required: false, label: 'l', fallback: 'your team channel' },
        ] },
      ],
    };
    expect(agentTemplateZodSchema.safeParse(t).success).toBe(true);
  });

  it('rejects a placeholder in the gallery card, which nothing substitutes', () => {
    // The card is what a person browsing the catalog reads, and it is not one
    // of the three fields substitution touches, so a placeholder there reaches
    // them with the braces still in it.
    const t = withObjects([obj('alert-channel', 'channel')]) as Record<string, unknown>;
    t.description = 'Posts the digest to {{pick:alert-channel}} before stand-up';
    const result = agentTemplateZodSchema.safeParse(t);
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/never substituted/i);
  });

  // A third case used to sit here, asserting the same for an escalation
  // description. `escalationPatterns` is gone: nothing in any repo read it, the
  // oversight queue it was believed to feed is driven by workspace settings,
  // and no customer-facing page rendered it. Removed with the field rather than
  // rewritten, because there is no longer a third substituted surface to guard.

  it('rejects two files for the same reason', () => {
    const result = agentTemplateZodSchema.safeParse(
      withObjects([obj('positioning', 'file', 'read'), obj('pricing', 'file', 'read')]),
    );
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(/two file picks/i);
  });
});
