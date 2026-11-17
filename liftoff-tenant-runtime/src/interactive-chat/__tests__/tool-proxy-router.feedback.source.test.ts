// Change D D.2.4: assert chat_feedback source on BOTH feedback branches.

import { readFileSync } from 'fs';
import { join } from 'path';

describe('tool-proxy-router feedback source (static contract)', () => {
  it('chat_feedback source appears in both supersede-fallback and new-save branches', () => {
    const path = join(__dirname, '..', 'tool-proxy-router.ts');
    const src = readFileSync(path, 'utf8');
    const idx = src.indexOf("/:agentId/feedback");
    expect(idx).toBeGreaterThan(-1);
    const region = src.slice(idx, idx + 5000);
    // Should appear at least twice (both branches).
    const matches = region.match(/nodeType:\s*'chat_feedback'\s*as\s*const/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
