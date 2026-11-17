// A finished turn must never leave the thread empty, on EVERY chat surface.
//
// A turn that ends in a terminal state the handler does not persist for writes
// nothing anywhere, so the person retries into the same silence. That half is
// covered in the tenant runtime's chat-turn-handler.
//
// The platform assistants can break the same promise by a quieter route: if
// they persist `content: finalText` straight through, a turn that runs and ends
// without prose leaves an EMPTY assistant row. An empty bubble and a missing one
// read the same way to the person, and both are indistinguishable from a turn
// that never ran.
//
// Source-level because the property is about what these two files persist on a
// path a unit test would have to drive an entire streaming tool-use loop to
// reach. The shape of the write is the thing worth freezing.

import { readFileSync } from 'fs';
import { join } from 'path';
import { COMPLETED_WITHOUT_REPLY } from '../completed-without-reply';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

const LIFTOFF = read('liftoff/chat-service.ts');
const INSIGHTS = read('insights/chat-service.ts');

describe('the platform assistants never persist an empty reply', () => {
  it('Liftoff falls back rather than storing empty text', () => {
    expect(LIFTOFF).toContain('content: finalText || COMPLETED_WITHOUT_REPLY');
    // The bare write is the defect. Its absence is the property.
    expect(LIFTOFF).not.toMatch(/content: finalText,/);
  });

  it('the Insights Manager falls back only when it said nothing at all', () => {
    // A turn that answered entirely with a visualization HAS said something, so
    // the fallback must not overwrite a block-only reply with "Done."
    expect(INSIGHTS).toMatch(
      /const saidSomething = cleanedText\.trim\(\)\.length > 0 \|\| blocks\.length > 0;/,
    );
    expect(INSIGHTS).toContain('content: saidSomething ? cleanedText : COMPLETED_WITHOUT_REPLY');
    expect(INSIGHTS).not.toMatch(/content: cleanedText,/);
  });

  it('both read the one constant rather than spelling it themselves', () => {
    // Two surfaces with two spellings of one ending is the drift this module
    // exists to prevent: a person moving between them would be shown two
    // different accounts of the same thing.
    for (const source of [LIFTOFF, INSIGHTS]) {
      expect(source).toContain("from '../shared/completed-without-reply'");
      expect(source).not.toMatch(/const COMPLETED_WITHOUT_REPLY\s*=/);
    }
  });

  it('leaves a turn the PERSON stopped alone', () => {
    // ADR-041: nothing is invented there. The assistant never spoke, and a
    // marker in the content would put words in its mouth. Both surfaces return
    // before the persist, carrying a terminal frame with no message.
    for (const source of [LIFTOFF, INSIGHTS]) {
      expect(source).toMatch(/yield \{ type: 'complete', message: null \};/);
    }
    expect(LIFTOFF).toMatch(/if \(userStopped && !finalText\)/);
    expect(INSIGHTS).toMatch(/if \(userStopped && !cleanedText\.trim\(\)\)/);
  });

  it('says the same thing the tenant runtime says, in the product voice', () => {
    // Deliberately identical to the team-agent fallback in
    // interactive-chat/chat-turn-handler.ts.
    expect(COMPLETED_WITHOUT_REPLY).toBe('Done.');
    expect(COMPLETED_WITHOUT_REPLY).not.toMatch(/—/);
    expect(COMPLETED_WITHOUT_REPLY).not.toMatch(/\b\w+'(s|t|re|ll|ve|d)\b/);
    expect(COMPLETED_WITHOUT_REPLY.toLowerCase()).not.toMatch(/\bagent\b/);
    // Short enough to read as a person speaking rather than a status page.
    expect(COMPLETED_WITHOUT_REPLY.length).toBeLessThanOrEqual(40);
  });
});
