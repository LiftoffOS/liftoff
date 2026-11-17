// Change D D.2.1: assert system_event source on reflection-applied memory.

import { readFileSync } from 'fs';
import { join } from 'path';

describe('suggestion-applier source (static contract)', () => {
  it('saveMemory call inside applySuggestion uses nodeType=system_event with refId=suggestionId', () => {
    // The applySuggestion function has a wide dependency surface (LLM gateway,
    // entitlements, instruction compilation, audit pubsub). Mocking all of it
    // for a single source-block assertion is heavier than the assertion itself,
    // so we make a static contract check against the source file.
    const path = join(__dirname, '..', 'suggestion-applier.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/scopeKey: `reflection-applied-/);
    // Anchor on the saveMemory block specifically
    const anchor = src.indexOf("scopeKey: `reflection-applied-");
    const region = src.slice(anchor, anchor + 1000);
    expect(region).toMatch(/nodeType:\s*'system_event'\s*as\s*const/);
    expect(region).toMatch(/refId:\s*suggestionId/);
    expect(region).toMatch(/triggerType:\s*'suggestion_applied'/);
  });
});
