// The per-tool rules survive the whole journey, or they are dead configuration.
//
// This field crosses six boundaries between the distiller deciding it and a
// model reading it: the control plane's agent row, the runtime config event,
// FOUR separate compiler-input builders in this file, the compiled_instructions
// column, two instruction loaders, and three places that describe a tool.
//
// Every one of those is an explicit hand-off written field by field, and a
// field left out of one of them is silent in both directions: the control plane
// stores the rules and reports success, and the runtime builds a catalog that
// looks right because the descriptions in it are the vendor's own.
//
// I shipped exactly that defect once already in this feature — applied in the
// adapter catalog alone, absent on the default engine — so this asserts the
// transport rather than trusting it.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('every compiler-input builder carries the field', () => {
  const subscriber = read('events/subscriber.ts');

  it('hands it over wherever it hands over resultRules', () => {
    // Anchored on resultRules rather than a hand-written list of line numbers:
    // both are per-tool policy the control plane decides and the runtime
    // compiles, so anywhere one is handed over is a place the other belongs.
    // A fifth builder added later fails here instead of shipping half a policy.
    const rules = (subscriber.match(/resultRules: payload\.resultRules,/g) ?? []).length;
    const overrides = (subscriber.match(/toolDescriptionOverrides: payload\.toolDescriptionOverrides,/g) ?? []).length;
    expect(rules).toBeGreaterThanOrEqual(4);
    expect(overrides).toBe(rules);
  });

  it('declares it on every payload type that declares resultRules', () => {
    // A builder cannot pass what its payload type does not admit exists.
    const rules = (subscriber.match(/resultRules\?: Array</g) ?? []).length;
    const overrides = (subscriber.match(/toolDescriptionOverrides\?: Record<string, string>;/g) ?? []).length;
    expect(overrides).toBe(rules);
  });
});

describe('the column exists and is written and read', () => {
  it('the compiler writes it', () => {
    const svc = read('instruction-compiler/internal-agent-instruction-service.ts');
    expect(svc).toContain('tool_description_overrides');
    expect(svc).toContain('input.toolDescriptionOverrides ?? {}');
  });

  it('both instruction loaders read it', () => {
    // Two loaders, and only one of them uses SELECT *. The chat loader names
    // its columns, so a field absent from that list is absent for every chat
    // turn while working perfectly on the autonomous path.
    const chat = read('interactive-chat/chat-turn-handler.ts');
    expect(chat).toContain('tool_description_overrides,');
    expect(chat).toContain('row.tool_description_overrides');
    expect(read('agent-execution/service.ts')).toContain('row.tool_description_overrides');
  });

  it('there is a migration adding the column', () => {
    const migrations = readFileSync(
      join(SRC, '..', 'migrations', '393_compiled_instruction_grounding_and_overrides.sql'),
      'utf8',
    );
    expect(migrations).toContain('ADD COLUMN IF NOT EXISTS tool_description_overrides');
    expect(migrations).toContain("DEFAULT '{}'::jsonb");
  });
});
