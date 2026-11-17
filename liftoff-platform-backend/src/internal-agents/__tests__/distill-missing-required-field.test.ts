// A required field the model simply forgot is the most retryable failure there is.
//
// `instructionsMd` missing from produce_agent threw, and the throw was not in
// RETRYABLE_ERROR_PATTERNS — so isRetryableError said false and the loop's catch
// rethrew on attempt ONE. Every other defect in the same output gets three
// attempts with feedback naming what was wrong: an unknown tool, a broken
// reference, an undeliverable trigger, a guessed outputField. An omitted field
// got none.
//
// It can block a redistill outright when a manual retry seconds later would
// succeed. Nothing about the input causes it; the model just leaves a field
// out. That is precisely
// what a retry is for, and needing a person to notice a 500 and press again is
// the part worth deleting.
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

describe('a produce_agent call missing instructionsMd', () => {
  it('retries with feedback instead of throwing on the first attempt', () => {
    // The guard must sit INSIDE the attempt loop and continue, not throw
    // straight out of it.
    const guard = SOURCE.slice(SOURCE.indexOf('if (!toolInput.instructionsMd) {'));
    const body = guard.slice(0, guard.indexOf('}\n\n'));
    expect(body).toContain('attempt < MAX_RETRIES - 1');
    expect(body).toContain('continue;');
  });

  it('names the omission in the feedback rather than re-asking blindly', () => {
    // Re-issuing an identical request and hoping is what burns the budget the
    // other validators spend on naming the defect.
    const guard = SOURCE.slice(SOURCE.indexOf('if (!toolInput.instructionsMd) {'));
    expect(guard.slice(0, 1500)).toContain('instructionsMd');
    expect(guard.slice(0, 1500)).toContain('REQUIRED');
  });

  it('still fails loudly once the retries are spent', () => {
    // Silently shipping an agent with no instructionsMd would be worse than the
    // 500 this replaces.
    const guard = SOURCE.slice(SOURCE.indexOf('if (!toolInput.instructionsMd) {'));
    expect(guard.slice(0, 2000)).toContain("throw new Error('distill: instructionsMd missing from LLM output')");
  });
});
