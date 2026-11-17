// The correction handed back to the model must contain the answer.
//
// `unknown_tool` feedback listed the first TEN catalog keys and truncated the
// rest with "...". That text is what the retry loop gives the model to fix the
// step from, so when the tool it needs falls outside those ten the correction
// actively conceals it and the retry has nothing to converge on.
//
// For example, a distilled step can call `send_message`, which does not exist.
// Gmail's catalog offers `send_email` AND `reply_to_thread`, and a truncation
// that cuts at `list_threads…` — alphabetically one position before
// `send_email` — hides both. The model retries, still cannot see a send tool,
// fails again, and the caller drops the graph. The agent loses all of its
// steps to a message that withheld the fix.

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

/** The unknown_tool branch, isolated so assertions cannot drift onto other code. */
function unknownToolBranch(): string {
  const start = source.indexOf("} else if (step.toolName && !catalog.has(step.toolName)) {");
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("// Verify onSuccess references", start));
}

describe('unknown_tool feedback', () => {
  it('no longer truncates the catalog', () => {
    // The exact regression: a slice cap puts the needed tool out of reach of the
    // retry that is supposed to find it.
    const branch = unknownToolBranch();
    expect(branch).not.toMatch(/\.slice\(0,\s*10\)/);
    expect(branch).not.toContain("catalog.size > 10 ? '...' : ''");
  });

  it('lists every available tool', () => {
    const branch = unknownToolBranch();
    expect(branch).toContain('Every available tool:');
    expect(branch).toMatch(/const all = \[\.\.\.catalog\.keys\(\)\]/);
    expect(branch).toMatch(/all\.join\(/);
  });

  it('surfaces near-miss names first, since that is the common failure', () => {
    // `send_message` → `send_email`: the shared prefix is the whole clue, and a
    // model scanning a long list benefits from having it named.
    const branch = unknownToolBranch();
    expect(branch).toContain('Closest by name:');
    expect(branch).toMatch(/const near = all\.filter/);
  });

  it('strips the connector prefix before comparing names', () => {
    // Catalog keys are `google-mail-14a82d9e__send_email`. Matching on the raw
    // key would compare against the connector alias rather than the operation,
    // and every tool on the connector would look equally close.
    const branch = unknownToolBranch();
    expect(branch).toMatch(/includes\('__'\)/);
    expect(branch).toMatch(/indexOf\('__'\) \+ 2/);
  });

  it('omits the near-miss clause when nothing is close', () => {
    // An empty "Closest by name:" would be noise, and worse, would read as
    // "there is nothing like this" when the full list follows.
    const branch = unknownToolBranch();
    expect(branch).toMatch(/near\.length > 0 \?/);
  });
});
