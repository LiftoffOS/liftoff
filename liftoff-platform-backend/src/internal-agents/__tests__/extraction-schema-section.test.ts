// The column contract reaches the tool built to take it.
//
// What these pin: a template's `extractionSchema` is the `columns` argument of
// `tabular_extract`, so it must arrive in the distill prompt as data and be
// compiled into a step, not described in prose. Every column, its prompt text
// intact, and the tool named in the step rather than in copy a person reads.

import { buildExtractionSchemaSection } from '../distill-service';

const COLUMNS = [
  { index: 0, name: 'Parties', format: 'text', prompt: 'Who are the parties to this agreement? Give full legal names.' },
  { index: 1, name: 'Effective Date', format: 'date', prompt: 'What is the effective date?' },
  { index: 2, name: 'Limitation of Liability', format: 'text', prompt: 'Is liability capped? State the cap and its exclusions.' },
];

describe('buildExtractionSchemaSection', () => {
  it('is empty for a role with no column contract', () => {
    // Most templates declare none, and TeamBuilder agents have no template at
    // all, so the common case must add nothing to the prompt.
    expect(buildExtractionSchemaSection(undefined)).toBe('');
    expect(buildExtractionSchemaSection([])).toBe('');
  });

  it('carries every column through, with its prompt text intact', () => {
    const out = buildExtractionSchemaSection(COLUMNS);
    for (const column of COLUMNS) {
      expect(out).toContain(column.name);
      expect(out).toContain(column.prompt);
    }
  });

  it('names the tool the columns are for', () => {
    // The gap was never the tool. It was that nothing connected the two.
    expect(buildExtractionSchemaSection(COLUMNS)).toContain('tabular_extract');
  });

  it('asks for a step, not a description', () => {
    const out = buildExtractionSchemaSection(COLUMNS);
    expect(out).toMatch(/workflowSteps tool_call/i);
    expect(out).toMatch(/toolArgs\.columns/);
  });

  it('forbids summarizing, merging or reordering the contract', () => {
    // A column list is a contract. Losing one is invisible downstream.
    expect(buildExtractionSchemaSection(COLUMNS)).toMatch(/EXACTLY as given/);
  });

  it('keeps the tool name out of what people read', () => {
    // systemPrompt and userInstructions are customer-facing, and naming our own
    // tools there is a copy violation the catalog already lints for. The
    // primitive belongs in the compiled step, not in the prose.
    expect(buildExtractionSchemaSection(COLUMNS))
      .toMatch(/Say nothing about `tabular_extract` in systemPrompt or userInstructions/);
  });

  it('states the column count, so a dropped column is checkable', () => {
    expect(buildExtractionSchemaSection(COLUMNS)).toContain('3 columns');
  });
});

// The same columns, two different deliverables. A review memo answers each
// topic once; a conditions-precedent checklist has one line per condition. The
// column contract cannot tell them apart, so the row definition does.
describe('buildExtractionSchemaSection with a row definition', () => {
  const out = () => buildExtractionSchemaSection(COLUMNS, 'condition precedent');

  it('compiles to the enumerator instead', () => {
    expect(out()).toContain('tabular_enumerate');
  });

  it('names the row unit in the step, since the columns do not imply it', () => {
    expect(out()).toMatch(/toolArgs\.rowDefinition.*"condition precedent"/s);
  });

  it('says plainly why the single-row tool is wrong here', () => {
    // Picking the wrong one of the two is not a visible failure: a table
    // collapsed to one row is still a well-formed table.
    expect(out()).toMatch(/Do NOT use `tabular_extract`/);
    expect(out()).toMatch(/still looks like a valid grid/);
  });

  it('keeps the enumerator out of what people read', () => {
    expect(out()).toMatch(/Say nothing about `tabular_enumerate` in systemPrompt/);
  });

  it('carries the columns through unchanged, exactly as the single-row case does', () => {
    for (const column of COLUMNS) {
      expect(out()).toContain(column.prompt);
    }
    expect(out()).toMatch(/EXACTLY as given/);
  });

  it('ignores a blank row definition rather than emitting an empty unit', () => {
    expect(buildExtractionSchemaSection(COLUMNS, '   ')).toContain('tabular_extract');
    expect(buildExtractionSchemaSection(COLUMNS, '   ')).not.toContain('tabular_enumerate');
  });
});
