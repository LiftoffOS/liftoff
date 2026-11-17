// Change D D.2.3: assert agent_action source on chat memory-save.

import { readFileSync } from 'fs';
import { join } from 'path';

describe('tool-proxy-router memory-save source (static contract)', () => {
  it('passes nodeType=agent_action with origin=chat-memory-save', () => {
    const path = join(__dirname, '..', 'tool-proxy-router.ts');
    const src = readFileSync(path, 'utf8');
    // Anchor on the /memory-save handler's source block
    const idx = src.indexOf("/:agentId/memory-save");
    expect(idx).toBeGreaterThan(-1);
    const region = src.slice(idx, idx + 2000);
    expect(region).toMatch(/nodeType:\s*'agent_action'\s*as\s*const/);
    expect(region).toMatch(/origin:\s*'chat-memory-save'/);
  });
});
