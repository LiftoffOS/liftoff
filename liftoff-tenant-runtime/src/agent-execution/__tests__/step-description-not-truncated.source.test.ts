/**
 * A step's authored instruction reaches the model in full.
 *
 * `truncateForPrompt` is for UNKNOWN runtime values — its own header says so,
 * and it shrinks a long string to 200 characters plus a marker before falling
 * back to a byte cap. It was applied to `step.description`, which is authored by
 * the distiller and bounded at write time. For an `llm_reason` step that
 * description IS the prompt, so the agent executed on roughly a quarter of an
 * instruction that had been stored in full — silently, on every run, with a
 * dead zone (513-1000 characters) where the value saved cleanly and was then
 * gutted at execution.
 *
 * Every reference implementation bounds the other direction: agno compresses
 * tool *results*, hermes-agent caps terminal output at a configurable 50,000,
 * deer-flow truncates fetched GitHub content, omnigent caps tool output and
 * appends a notice. None of them shorten the instruction.
 *
 * `service.ts` cannot be imported here (it pulls DB + SDK transitively), so this
 * asserts the prompt construction directly, matching the other *.source tests.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

describe('step objective is not truncated', () => {
  it('passes step.description into the step prompt whole', () => {
    // It is RESOLVED now rather than literal — `{{steps.s5.body}}` in an
    // instruction is a pointer where the content belongs, and the model
    // paraphrased the pointer to the person as "step s5". Resolution replaces
    // the reference with the value; it does not shorten anything, so the
    // property this file exists for is untouched. The resolved text is bound
    // to a name once (its length is reported beside the earlier-outputs
    // section) and that name is what the objective line carries.
    expect(SOURCE).toMatch(/const resolvedObjective = resolveStepProse\(step\.description/);
    expect(SOURCE).toMatch(/`Step objective: \$\{resolvedObjective\}`/);
  });

  it('never shortens the description on the way through that resolution', () => {
    // The regression this file guards, restated against the new expression: a
    // budget applied here silently rewrites the agent's instruction.
    const helper = SOURCE.slice(
      SOURCE.indexOf('function resolveStepProse('),
      SOURCE.indexOf('function resolveStepProse(') + 400,
    );
    expect(helper).not.toMatch(/truncateForPrompt|slice\(|substring\(/);
  });

  it('never wraps step.description in truncateForPrompt', () => {
    // The specific regression: any budget here silently rewrites the agent's
    // instruction, and the value is already bounded at write time.
    expect(SOURCE).not.toMatch(/truncateForPrompt\(\s*step\.description/);
  });

  it('still bounds the genuinely unbounded values in the same prompt', () => {
    // Prior step output and workflow input arrive from tools and callers with no
    // size contract. Removing their bounds would blow the context window, which
    // is what the helper is for.
    // stepOutput is bounded via compressForPrompt, which compresses semantically
    // and returns truncateForPrompt's deterministic bound when compression is
    // disabled or fails — so it is always bounded, just not always by a slice.
    expect(SOURCE).toMatch(/compressForPrompt\(stepOutput, \{/);
    expect(SOURCE).toMatch(/maxChars: STEP_OUTPUT_BUDGET/);
    expect(SOURCE).toMatch(/truncateForPrompt\(inputData \?\? \{\},\s*\w+\)/);
  });
});
