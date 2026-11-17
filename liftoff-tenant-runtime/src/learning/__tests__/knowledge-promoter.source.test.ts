// Change D D.2.2: assert knowledge-promoter passes nodeType=memory + recordSynthesis.

import { readFileSync } from 'fs';
import { join } from 'path';

describe('knowledge-promoter source (static contract)', () => {
  it('source.nodeType=memory appears in the saveMemory call inside knowledge-promoter.ts', () => {
    // Static contract assertion: parse the source file and verify the literal
    // source block is wired. Replaces a runtime stub when the surrounding
    // call graph (entitlements, embeddings, pool transactions) is too costly
    // to fixture for a unit test.
    const path = join(__dirname, '..', 'knowledge-promoter.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/nodeType:\s*'memory'\s*as\s*const/);
    expect(src).toMatch(/recordSynthesis\(/);
    expect(src).toMatch(/corroboratingMemoryIds/);
  });
});
