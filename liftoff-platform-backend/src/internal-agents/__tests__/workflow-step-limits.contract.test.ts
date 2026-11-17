// The layers that touch a workflow step's description must agree.
//
// They did not, and the disagreement was invisible where it mattered most:
//
//   generator (distill tool schema)   500 on tool_call, unbounded on the rest
//   distill validation               500
//   persisted (create + update zod)  1000  ← rejected the team with a bare 400
//   runtime step prompt              512, shrinking long strings to ~200
//
// A description of 513-1000 characters therefore saved cleanly and was silently
// cut to roughly 200 characters on every run. For an `llm_reason` step, whose
// description IS the prompt, the agent executed on a fraction of an instruction
// that had been stored in full.
//
// This is the fourth defect of the same shape in one night — a contract agreed in
// one place and violated in another, alongside a `capabilities` column that never
// existed, `instructionsMd` nullable on update but not create, and `text_break`
// wired at two of three hops. So the guard is on the shape, not the instance:
// one constant, and every layer reading it.
//
// The runtime half of the contract (no truncation of the authored instruction)
// is enforced in the tenant runtime by
// agent-execution/__tests__/step-description-not-truncated.source.test.ts.

import { readFileSync } from 'fs';
import { join } from 'path';
import { WORKFLOW_STEP_DESCRIPTION_MAX } from '../workflow-step-limits';

const SRC = join(__dirname, '..');
// The persisted request schemas live in workspace-actions/schemas.ts, shared
// by the dashboard routes and the assistants' team tools.
const ROUTER = readFileSync(join(SRC, '..', 'workspace-actions', 'schemas.ts'), 'utf8');
const DISTILL = readFileSync(join(SRC, 'distill-service.ts'), 'utf8');

describe('workflow step description bound is shared', () => {
  it('is generous enough that a real objective is never rejected', () => {
    // Sized to stop abuse, not to enforce style — comparable authored fields
    // allow 50,000 (userInstructions) and 16,384 (toolInputTemplate), and no
    // reference agent framework caps authored instruction text at all.
    expect(WORKFLOW_STEP_DESCRIPTION_MAX).toBeGreaterThanOrEqual(10_000);
  });

  it('the persisted schema reads the shared constant, not a literal', () => {
    expect(ROUTER).toContain('description: z.string().max(WORKFLOW_STEP_DESCRIPTION_MAX)');
    // The literals that used to disagree must not come back on this field.
    expect(ROUTER).not.toMatch(/stepId: z\.string\(\)[\s\S]{0,80}description: z\.string\(\)\.max\(\d+\)/);
  });

  it('every generator step variant declares the shared constant', () => {
    // tool_call carried 500 while llm_reason, ask_user and delay carried no
    // bound at all, so the generator was free to emit what storage would reject.
    // Scoped to the workflowSteps block: other fields legitimately carry small
    // numeric caps (a skill's description is a 300-char retrieval key).
    const start = DISTILL.indexOf('workflowSteps: {');
    expect(start).toBeGreaterThan(-1);
    const stepsBlock = DISTILL.slice(start, DISTILL.indexOf('triggerConfig:', start));

    const declared = stepsBlock.match(/maxLength: WORKFLOW_STEP_DESCRIPTION_MAX/g) ?? [];
    expect(declared.length).toBeGreaterThanOrEqual(4);
    expect(stepsBlock).not.toMatch(/description: \{ type: 'string'[^}]*maxLength: \d+/);
  });

  it('distill validation compares against the shared constant', () => {
    expect(DISTILL).toContain('WORKFLOW_STEP_DESCRIPTION_MAX');
    expect(DISTILL).not.toMatch(/WORKFLOW_STEP_DESCRIPTION_MAX = \d+/);
  });

  it('an over-long description is rejected for regeneration, never trimmed', () => {
    // Trimming would make the save succeed while changing what the agent does.
    // The validation error feeds the existing retry-with-feedback loop.
    expect(DISTILL).toContain("type: 'description_too_long'");
    expect(DISTILL).not.toMatch(/description\.slice\(0,|clampStepDescriptions/);
  });
});

// The same shape of contract, on the other authored field the generator writes.
//
// Skills are safe today for a reason worth pinning: every generator cap is
// STRICTER than its persisted counterpart, so unlike the step description there
// is no band of values that saves and then misbehaves. That relationship is the
// invariant — not the specific numbers, which are free to move.
describe('skill bounds run the same direction as the persisted caps', () => {
  const PERSISTED = { name: 255, description: 1000, instruction: 10_000 };

  function generatorCap(field: 'name' | 'description' | 'instruction'): number {
    const start = DISTILL.indexOf('skills: {');
    expect(start).toBeGreaterThan(-1);
    const block = DISTILL.slice(start, DISTILL.indexOf('workflowSteps: {', start));
    // Whitespace-tolerant: a field whose description outgrows one line is
    // formatted as a multi-line object, and the cap it carries is the same cap.
    const match = block.match(
      new RegExp(`${field}: \\{\\s*type: 'string',?[\\s\\S]*?maxLength: (\\d+)`),
    );
    expect(match).not.toBeNull();
    return Number(match![1]);
  }

  it.each(['name', 'description', 'instruction'] as const)(
    'the generator cap on %s cannot exceed what storage accepts',
    (field) => {
      // If this ever inverts, the generator can emit a skill the create rejects —
      // and a rejected create is the bare 400 this whole change exists to remove.
      expect(generatorCap(field)).toBeLessThanOrEqual(PERSISTED[field]);
    },
  );

  it('the persisted caps this test asserts against are the ones in the router', () => {
    // Pins the other half: the numbers above are read off skillObjectSchema, so a
    // change there has to come here rather than silently invalidating the check.
    expect(ROUTER).toContain('name: z.string().min(1).max(255)');
    expect(ROUTER).toContain('description: z.string().min(1).max(1000)');
    expect(ROUTER).toContain('instruction: z.string().min(1).max(10000)');
  });
});
