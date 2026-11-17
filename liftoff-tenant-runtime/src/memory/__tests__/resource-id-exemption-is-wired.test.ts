// The exemption is only worth anything if the call sites pass it.
//
// `redactCredentials` defaults `keepResourceIds` to OFF, deliberately, so every
// existing caller keeps its behaviour. The consequence is that the fix is one
// argument at two call sites, and a redactor that handles resource ids correctly
// while nothing asks it to would pass every test in redactor.resource-ids and
// still store `[REDACTED:high_entropy_string]` in production.
//
// That is this codebase's dominant defect class, wired at one end, and it is the
// shape of other bugs here too: a loop contract
// derived from reads that never collected loop reads, a classifier reading a
// type that its own throw site destroyed, and a park route mode its only caller
// never used. So the call sites are asserted directly.
//
// Source rather than behaviour, and the reason is not convenience: every
// runtime path to this code is correctly gated. A chat-initiated save is refused
// by the admit gate as task state, and the workflow step that does write the
// registry is refused by the sweep's own weekly idempotency check. The only
// unblocked route is a scheduled run. A test that cannot run until Monday is not
// a test.

import { readFileSync } from 'fs';
import { join } from 'path';

const HANDLER = readFileSync(
  join(__dirname, '..', '..', 'tools', 'standard-tool-handler.ts'),
  'utf8',
);

/** The window of source belonging to one handler, from its name to the next
 *  `async function` after it. Bounded that way rather than by a character count
 *  so a comment of any length cannot push the call out of view. */
function handlerBody(name: string): string {
  const at = HANDLER.indexOf(`async function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const next = HANDLER.indexOf('\nasync function ', at + 1);
  return HANDLER.slice(at, next === -1 ? HANDLER.length : next);
}

describe('the resource-id exemption reaches the calls that need it', () => {
  it('memory_save asks for it', () => {
    const body = handlerBody('handleMemorySave');
    expect(body).toMatch(/redactCredentials\(\s*content,\s*\{\s*keepResourceIds:\s*true\s*\}\s*\)/);
  });

  it('the research-finding save asks for it on every field it scrubs', () => {
    const body = handlerBody('handleResearchSaveFinding');
    // Three fields, and a finding whose summary keeps its ids while its details
    // lose them is still a broken citation.
    for (const field of ['title', 'summary', 'details']) {
      expect(body).toMatch(new RegExp(`redactCredentials\\(${field}, KEEP_IDS\\)`));
    }
  });

  it('tells the model when something WAS removed, in a sentence', () => {
    // `redactions` was always returned and was ignored: on the run that lost
    // eleven ids the model had all eleven matches on a SUCCESS result and
    // reported the memory saved. A {kind, span, original_length} list is not
    // something a model acts on.
    const body = handlerBody('handleMemorySave');
    expect(body).toContain('redactionNote');
    expect(body).toMatch(/What you wrote is NOT what was saved/);
  });

  it('leaves every OTHER caller on the default, so the exemption stays narrow', () => {
    // The reflection and consolidation paths run over model-generated summaries
    // rather than an agent's explicit write, and keep full scrubbing.
    const sanitizer = readFileSync(join(__dirname, '..', 'content-sanitizer.ts'), 'utf8');
    expect(sanitizer).toMatch(/redactCredentials\(content\)/);
    expect(sanitizer).not.toContain('keepResourceIds');
    const router = readFileSync(join(__dirname, '..', 'router.ts'), 'utf8');
    expect(router).not.toContain('keepResourceIds');
  });
});
