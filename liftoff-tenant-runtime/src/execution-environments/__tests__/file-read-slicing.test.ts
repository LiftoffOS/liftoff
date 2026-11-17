// Reading back a value the platform parked must not require a shell.
//
// The loop this closes:
//   1. a step output is too large for the conversation, so it is parked to
//      /workspace/run-values/step-output-sN.json
//   2. the note attached to it says "call file_read with that path"
//   3. file_read took only `path`, so it returned the whole oversized value
//   4. still too large, so the SDK spilled it to a file of its own and told the
//      model to slice it by character range with a shell
//   5. that shell is `code_execute`, categorised destructive, so on a run that
//      has read any external content the taint gate stopped it and raised a
//      LEVEL 3 "acting on outside content" approval — for reading a file this
//      platform wrote, one step earlier, in the same run
//
// An agent that follows the platform's own instructions at every step still
// ends up waiting on approvals; the instructions were impossible to follow,
// because the one tool they named could not return part of a file.
//
// Character offsets, not lines: parked values are single-line JSON, which is
// precisely the shape line-based chunking cannot help with.
import { sliceForRead } from '../sandbox-executor';

const BIG = 'x'.repeat(1000);

describe('sliceForRead', () => {
  it('returns the whole file when nothing is asked for', () => {
    const r = sliceForRead(BIG, undefined, undefined);
    expect(r.returned).toBe(1000);
    expect(r.totalChars).toBe(1000);
    expect(r.hasMore).toBe(false);
    // No note on a complete read — a note that always appears is noise the model
    // learns to skip, which is how the one that matters gets missed.
    expect(r.note).toBe('');
  });

  it('returns a slice and says, in the text, that there is more', () => {
    const r = sliceForRead(BIG, 0, 400);
    expect(r.returned).toBe(400);
    expect(r.hasMore).toBe(true);
    expect(r.note).toContain('Showing characters 0-400 of 1000');
    expect(r.note).toContain('offset=400');
  });

  it('walks to the end across slices without gap or overlap', () => {
    let offset = 0;
    let seen = 0;
    for (let i = 0; i < 10; i++) {
      const r = sliceForRead(BIG, offset, 300);
      seen += r.returned;
      offset = r.offset + r.returned;
      if (!r.hasMore) break;
    }
    expect(seen).toBe(1000);
    expect(offset).toBe(1000);
  });

  it('marks the final slice complete so the model stops', () => {
    const r = sliceForRead(BIG, 700, 300);
    expect(r.hasMore).toBe(false);
    expect(r.returned).toBe(300);
    // Still announces the range: a slice starting at 700 is not the file, even
    // though it reaches the end.
    expect(r.note).toContain('Showing characters 700-1000 of 1000');
  });

  it('treats a nonsense offset as the start rather than failing the read', () => {
    expect(sliceForRead(BIG, -5, undefined).offset).toBe(0);
    expect(sliceForRead(BIG, 'abc', undefined).offset).toBe(0);
    expect(sliceForRead(BIG, undefined, -1).returned).toBe(1000);
  });

  it('reads past the end as an empty, complete slice', () => {
    const r = sliceForRead(BIG, 5000, 100);
    expect(r.returned).toBe(0);
    expect(r.hasMore).toBe(false);
  });

  it('handles an empty file without claiming there is more', () => {
    const r = sliceForRead('', 0, 100);
    expect(r.returned).toBe(0);
    expect(r.totalChars).toBe(0);
    expect(r.hasMore).toBe(false);
  });
});
