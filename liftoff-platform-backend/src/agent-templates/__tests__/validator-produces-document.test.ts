// `producesDocument` — the deliverable is a file, so it needs a required place
// to be written.
//
// The distiller turns the flag into "the graph MUST write the file to the
// bound documents or cloud-storage connector" and stands its fence down when
// none is bound. An optional destination therefore makes the obligation hold
// for the hires that connected one and lapse for the rest, and it empties the
// gallery card, which draws only the required connectors. Five marketing
// templates shipped with the flag on an optional documents connector; these
// pin the rule that stops the sixth.

// Capability names come off the connector catalog's static fallback, the way
// catalog-validates reads them; with the cache stubbed out, 'documents' would
// be an unknown capability before this rule ever ran.
import { agentTemplateZodSchema } from '../validator';

const DOCS = { id: 'req-documents', capability: 'documents', role: 'tool', description: 'Where the report goes' };

function template(over: Record<string, unknown> = {}) {
  return {
    id: 'produces-document-test',
    displayName: 'Produces Document Test',
    departmentCategory: 'operations',
    description: 'description',
    roleSummary: 'roleSummary',
    role: 'Produces Document Test',
    responsibilities: '## Responsibilities\nRead the figures and write the report.',
    additionalContext: '## Rules\nbar',
    requiredConnectors: [DOCS],
    optionalConnectors: [],
    defaultAgentType: 'agent',
    defaultMemoryScope: {},
    defaultTriggerConfig: { type: 'manual' },
    schemaVersion: 1,
    producesDocument: true,
    ...over,
  };
}

const err = (r: { error?: { issues: unknown } }) => JSON.stringify(r.error?.issues ?? '');

it('accepts producesDocument with a required documents connector', () => {
  expect(agentTemplateZodSchema.safeParse(template()).success).toBe(true);
});

it('accepts producesDocument with a required connector that offers cloud storage among several capabilities', () => {
  const r = agentTemplateZodSchema.safeParse(template({
    requiredConnectors: [{ id: 'req-source', capabilities: ['cloud_storage', 'documents'], role: 'data_source', description: 'The source document' }],
  }));
  expect(r.success).toBe(true);
});

it('rejects producesDocument when the only documents connector is optional', () => {
  const r = agentTemplateZodSchema.safeParse(template({
    requiredConnectors: [],
    optionalConnectors: [{ ...DOCS, id: 'opt-documents', prose: { whenBound: 'as a document you create and link', whenUnbound: 'in your reply' } }],
    responsibilities: '## Responsibilities\nRead the figures and write the report {{connector:opt-documents}}.',
  }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/producesDocument is set but no required connector offers documents or cloud_storage/);
});

it('rejects producesDocument when the required connectors offer no store at all', () => {
  const r = agentTemplateZodSchema.safeParse(template({
    requiredConnectors: [{ id: 'req-crm', capability: 'crm', role: 'data_source', description: 'The CRM' }],
  }));
  expect(r.success).toBe(false);
  expect(err(r)).toMatch(/producesDocument is set but no required connector/);
});

it('says nothing about destinations when the deliverable is not a file', () => {
  const r = agentTemplateZodSchema.safeParse(template({
    producesDocument: false,
    requiredConnectors: [{ id: 'req-crm', capability: 'crm', role: 'data_source', description: 'The CRM' }],
  }));
  expect(r.success).toBe(true);
});
