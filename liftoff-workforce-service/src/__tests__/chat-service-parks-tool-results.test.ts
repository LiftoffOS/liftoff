// The CAIO turn is the caller that supplies a parker; the HRBP fan-out is the
// caller that does not.
//
// Pinned on the source, as the other chat-service contracts here are: booting
// the module pulls in DB pools and connector fetches for nothing this asserts.
// What it asserts is a wiring fact and nothing about the rule behind it —
// park-result.test.ts owns that.

import { readFileSync } from 'fs';
import { join } from 'path';

const CHAT_SERVICE = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'chat-service.ts'),
  'utf-8',
);
const HRBP_TASK_HANDLER = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'hrbp-task-handler.ts'),
  'utf-8',
);

describe('who parks a tool result larger than one message', () => {
  it('the CAIO turn supplies a parker, scoped to its own conversation', () => {
    expect(CHAT_SERVICE).toContain('parkOrBoundToolResult');
    expect(CHAT_SERVICE).toMatch(/parkToolResult:\s*\(toolName: string, data: unknown, serialized: string\)/);
    expect(CHAT_SERVICE).toMatch(/parkOrBoundToolResult\(\{ tenantId: input\.tenantId, threadId: input\.threadId! \}/);
  });

  it('only when the turn has a thread: a threadless greeting has no conversation to park for', () => {
    expect(CHAT_SERVICE).toMatch(/\.\.\.\(input\.threadId\s*\n\s*\? \{ parkToolResult:/);
  });

  it('the HRBP fan-out supplies none — it has no dataset tools to read one back with', () => {
    expect(HRBP_TASK_HANDLER).not.toContain('parkToolResult');
    expect(HRBP_TASK_HANDLER).not.toContain('parkOrBoundToolResult');
  });
});
