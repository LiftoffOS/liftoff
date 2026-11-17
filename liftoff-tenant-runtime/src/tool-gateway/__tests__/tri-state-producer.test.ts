// The producer half. This is the test that was missing, and its absence is why
// two features shipped that could never fire.
//
// A test that calls `refusalForTool` directly passes whether or not anything in
// production ever reaches it — the identical failure mode as the provenance
// reporter, whose unit test passed while an early return above it made the
// events unreachable. Testing a pure function proves the function; it says
// nothing about whether the system uses it.
//
// So these assert the WIRING: that the guard resolves its own input rather than
// trusting a caller to supply it, and that the forcing directive has a producer
// at all.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('the tri-state guard resolves its own input', () => {
  const svc = read('tool-gateway/service.ts');

  it('does NOT read the states off ExecuteInput', () => {
    // It did, and nothing ever set the field. ExecuteInput is built at a dozen
    // call sites; a field each one must remember is a field the next one
    // forgets, and the omission looks like ordinary code.
    expect(svc).not.toMatch(/const states = input\.capabilityStates/);
  });

  it('reads them from the stored instruction instead', () => {
    expect(svc).toContain('capabilityStatesFor(');
    const at = svc.indexOf('capabilityStatesFor(');
    // Keyed on the identity every ExecuteInput already carries, so a new
    // dispatch path inherits the refusal rather than opting out of it.
    const call = svc.slice(at, at + 200);
    expect(call).toContain('input.tenantId');
    expect(call).toContain('input.agentId');
    expect(call).toContain('input.instructionVersion');
  });

  it('is awaited on the dispatch path', () => {
    // A promise treated as truthy would refuse EVERY call, which is the
    // opposite failure and just as silent at compile time.
    expect(svc).toMatch(/await this\.guardCapabilityTriState\(input\)/);
  });

  it('fails OPEN when the lookup cannot answer', () => {
    // A database blip must not make an agent claim its tools do not exist.
    const lookup = read('tool-gateway/capability-states-lookup.ts');
    const at = lookup.indexOf('catch (err)');
    expect(lookup.slice(at, at + 400)).toContain('return {}');
  });
});

describe('native forcing has a producer', () => {
  const svc = read('agent-execution/service.ts');

  it('sets groundingToolName on the invocation input', () => {
    // Deleted once by an over-broad cleanup and caught by nobody: the field is
    // optional, so every adapter kept compiling while reading a value nothing
    // set. The value is the matched rule's tool, narrowed to one this request
    // declares (forcibleToolFor), and it is set on the input only when that
    // narrowing kept a tool.
    expect(svc).toMatch(/const groundingToolName = forcibleToolFor\(groundingRuleToolName,/);
    expect(svc).toMatch(/\.\.\.\(groundingToolName \? \{ groundingToolName \} : \{\}\)/);
  });

  it('derives it from the rule the prefetch actually matched', () => {
    // Not from the rule list, and not from the objective: the tool that gets
    // forced must be the one whose result was already appended, or the model is
    // pushed at a tool the turn was not grounded in.
    expect(svc).toMatch(/groundingRuleToolName = groundingOutcome\.rule\?\.toolName/);
  });

  it('the consumers read the same field name', () => {
    for (const rel of ['agent-execution/adapter/openai-wire/index.ts',
      'agent-execution/adapter/gemini/index.ts']) {
      expect(read(rel)).toContain('input.groundingToolName');
    }
  });
});
