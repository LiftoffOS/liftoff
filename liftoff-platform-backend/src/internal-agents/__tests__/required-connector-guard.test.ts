// `requiredConnectors` reads as a guarantee and was never one. The validator
// relied on the premise in its own words — "A required connector is always
// bound" — but a hire can require team chat, have only GitHub bound, and
// report notifying a channel it cannot reach.

import {
  assertRequiredConnectorsBound,
  RequiredConnectorMissingError,
} from '../required-connector-guard';

const PROVIDERS: Record<string, string[]> = {
  documents: ['google_docs', 'notion', 'google_drive'],
  team_chat: ['slack', 'microsoft_teams'],
  version_control: ['github', 'gitlab'],
};
const connectorTypesFor = ({ capability }: { capability: string }): string[] =>
  PROVIDERS[capability] ?? [];

const TEMPLATE = {
  id: 'competitive-intelligence-analyst',
  requiredConnectors: [{ id: 'req-documents', capability: 'documents' }],
};

const check = (
  bindings: Array<{ type?: string; integrationId?: string }>,
  status?: string,
  template = TEMPLATE,
) => assertRequiredConnectorsBound({ template, bindings, status, connectorTypesFor });

describe('a required connector must be bound', () => {
  it('refuses a hire with nothing bound', () => {
    expect(() => check([])).toThrow(RequiredConnectorMissingError);
  });

  it('names the capability, so the message says what to connect', () => {
    try {
      check([]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RequiredConnectorMissingError).context.capabilities).toEqual(['documents']);
      expect((err as Error).message).toContain('documents');
    }
  });

  it('accepts any connector carrying the capability', () => {
    // The point of a capability requirement: a team stands up on Drive or on
    // Notion, whichever the customer already uses.
    expect(() => check([{ integrationId: 'notion' }])).not.toThrow();
    expect(() => check([{ integrationId: 'google_docs' }])).not.toThrow();
  });

  it('reads a binding named by `type` as well as by `integrationId`', () => {
    expect(() => check([{ type: 'google_docs' }])).not.toThrow();
  });

  it('is not satisfied by an unrelated connector', () => {
    // The exact shape of the defect: something IS bound, just not this.
    expect(() => check([{ integrationId: 'github' }])).toThrow(RequiredConnectorMissingError);
  });

  it('lets a draft be saved before anything is connected', () => {
    expect(() => check([], 'draft')).not.toThrow();
  });

  it('still gates an active hire', () => {
    expect(() => check([], 'active')).toThrow(RequiredConnectorMissingError);
  });

  it('gates the ACTIVATION, which is the transition that actually happens', () => {
    // A hire is created as a draft and activated afterwards, so a gate on
    // creation alone sees only hires born active — which is none of them.
    // Creation returns 201 with status='draft'.
    expect(() => check([], 'active')).toThrow(RequiredConnectorMissingError);
    expect(() => check([{ integrationId: 'google_docs' }], 'active')).not.toThrow();
  });
});

describe('requirement shapes', () => {
  it('honours a requirement pinned to one connector type', () => {
    const t = { id: 't', requiredConnectors: [{ id: 'r', connectorType: 'linear' }] };
    expect(() => check([{ integrationId: 'linear' }], undefined, t)).not.toThrow();
    expect(() => check([{ integrationId: 'github' }], undefined, t)).toThrow();
  });

  it('accepts any one of several capabilities', () => {
    const t = { id: 't', requiredConnectors: [{ id: 'r', capabilities: ['documents', 'team_chat'] }] };
    expect(() => check([{ integrationId: 'slack' }], undefined, t)).not.toThrow();
  });

  it('ignores a requirement that names nothing checkable', () => {
    // Rather than refusing every hire on a template nobody can satisfy.
    const t = { id: 't', requiredConnectors: [{ id: 'r' }] };
    expect(() => check([], undefined, t)).not.toThrow();
  });

  it('passes a template with no required connectors at all', () => {
    expect(() => check([], undefined, { id: 't', requiredConnectors: [] })).not.toThrow();
  });
});
