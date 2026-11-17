// `extractionRowDefinition` decides which of two extractors a template
// compiles to, and the columns cannot tell them apart.
//
// Present, the deliverable holds many rows per document and the row unit says
// what a row is. Absent, it holds one row per document. Declaring the unit
// without any columns describes how to count rows in a table that has none: it
// compiles to nothing and still reads like an enforced shape, which is the
// failure this whole family exists to prevent.

jest.mock('../../connectors/connector-service-client', () => ({}));
jest.mock('../../connectors/connector-service-cache', () => ({}));

import { agentTemplateZodSchema } from '../validator';

const COLUMNS = [
  { index: 0, name: 'Clause', format: 'text', prompt: 'Describe the condition' },
];

function template(extra: Record<string, unknown>) {
  return {
    id: 'row-definition-test',
    displayName: 'X',
    departmentCategory: 'legal',
    description: 'description',
    roleSummary: 'roleSummary',
    role: 'role',
    responsibilities: '## Responsibilities\nfoo',
    additionalContext: '## Rules\nbar',
    requiredConnectors: [
      { id: 'req-docs', connectorType: 'google_drive', role: 'tool', description: 'd' },
    ],
    optionalConnectors: [],
    defaultAgentType: 'agent',
    defaultMemoryScope: {},
    defaultTriggerConfig: { type: 'manual' },
    schemaVersion: 2,
    ...extra,
  };
}

describe('extractionRowDefinition', () => {
  it('is accepted alongside a column contract', () => {
    const r = agentTemplateZodSchema.safeParse(
      template({ extractionSchema: COLUMNS, extractionRowDefinition: 'condition precedent' }),
    );
    expect(r.success).toBe(true);
  });

  it('is rejected without one, since there is no table to count rows in', () => {
    const r = agentTemplateZodSchema.safeParse(
      template({ extractionRowDefinition: 'condition precedent' }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/needs an extractionSchema/);
  });

  it('is rejected alongside an empty column contract', () => {
    const r = agentTemplateZodSchema.safeParse(
      template({ extractionSchema: [], extractionRowDefinition: 'covenant' }),
    );
    expect(r.success).toBe(false);
  });

  it('stays optional: one row per document is the common case', () => {
    const r = agentTemplateZodSchema.safeParse(template({ extractionSchema: COLUMNS }));
    expect(r.success).toBe(true);
  });

  it('survives parsing rather than being stripped', () => {
    // z.object() drops undeclared keys silently, which is how templateId went
    // missing once. A row unit lost this way would downgrade the enumerator
    // back to the single-row tool with nothing to show for it.
    const r = agentTemplateZodSchema.safeParse(
      template({ extractionSchema: COLUMNS, extractionRowDefinition: 'covenant' }),
    );
    expect(r.success && r.data.extractionRowDefinition).toBe('covenant');
  });

  it('rejects an empty string, which would read as "find every  in the document"', () => {
    const r = agentTemplateZodSchema.safeParse(
      template({ extractionSchema: COLUMNS, extractionRowDefinition: '' }),
    );
    expect(r.success).toBe(false);
  });
});
