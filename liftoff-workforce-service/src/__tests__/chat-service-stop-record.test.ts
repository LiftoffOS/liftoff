// What a stopped CAIO turn leaves behind.
//
// Booting runCAIOChatTurn in isolation pulls in DB pools, connector fetches and
// the visualization parser — the same reason chat-service-greeting-mode.test.ts
// locks the source-level contract instead. The branch that matters here exists
// only in chat-service.ts, so a rewrite that reintroduces the marker is caught.

import { readFileSync } from 'fs';
import { join } from 'path';

const CHAT_SERVICE = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'chat-service.ts'),
  'utf-8',
);

/** The source with comment lines removed. The marker is discussed in a comment
 *  explaining why it is gone, and that prose must not read as the code. */
const CHAT_SERVICE_CODE = CHAT_SERVICE.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

describe('a stopped turn writes no reply the Chief AI Officer never gave', () => {
  it('never writes a marker string into the message content', () => {
    // "(stopped)" in the content field becomes a chat bubble with a timestamp:
    // the transcript shows the agent saying it, which it never did.
    expect(CHAT_SERVICE_CODE).not.toContain('(stopped)');
  });

  it('ends the turn without persisting when the stop landed before any text', () => {
    expect(CHAT_SERVICE).toMatch(
      /if\s*\(terminatedEarly === 'STOPPED' && !cleanedText\.trim\(\)\)\s*\{/,
    );
    // Terminal all the same, so the composer stops streaming - it just carries
    // no message.
    expect(CHAT_SERVICE).toMatch(/yield\s*\{\s*type:\s*'complete',\s*message:\s*null\s*\}/);
  });

  it('keeps a partial reply when the stop landed after it had said something', () => {
    // The skip is conditional on there being no text; anything already written
    // still travels the normal persistence path below it.
    expect(CHAT_SERVICE).toMatch(/const\s*\{\s*cleanedText,\s*blocks\s*\}\s*=\s*parseVisualizationBlocks\(accumulatedText\)/);
  });
});
