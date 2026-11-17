// The CAIO's text is a reply a person is waiting to read, so its turn asks the
// loop to close the reply — and hands on the deadline the stream router set.
// Pinned on the source, as the other chat-service contracts are: booting the
// module pulls in DB pools and connector fetches for nothing this asserts.

import { readFileSync } from 'fs';
import { join } from 'path';

const CHAT_SERVICE = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'chat-service.ts'),
  'utf-8',
);

describe('the CAIO turn closes its reply', () => {
  it('passes the reply option, carrying the deadline it was given, to the loop', () => {
    expect(CHAT_SERVICE).toMatch(
      /reply:\s*\{\s*\.\.\.\(input\.replyDeadlineAt !== undefined \? \{ deadlineAt: input\.replyDeadlineAt \} : \{\}\),\s*askVerdict:\s*canContinue\s*\}/,
    );
  });

  it('records a reply closed at its deadline as such', () => {
    expect(CHAT_SERVICE).toMatch(/terminator === 'deadline'\) terminatedEarly = 'DEADLINE'/);
  });
});
