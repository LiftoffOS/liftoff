// Every writer of web_sessions.closed_at and takeover_state is one file.
//
// A takeover hold (migration 418) opens and closes exactly when the session's
// state does, because the two writes commit in one transaction — and that is
// only true while every transition goes through `startTakeover`, `endTakeover`
// and `closeSession` in browser-sessions/repository.ts. Seven raw writers were
// rerouted to get here; this stops the eighth. A new raw UPDATE of either
// column anywhere under src/ fails the build and says where to send it.

import * as fs from 'fs';
import * as path from 'path';

const SOURCE_ROOT = path.join(__dirname, '..', '..', '..');
const ONLY_WRITER = 'src/browser-sessions/repository.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      walk(p, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Each `UPDATE web_sessions` statement's SET clause, as text, per file. */
function sessionStateWrites(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const writes: string[] = [];
  const re = /UPDATE\s+web_sessions\b([\s\S]*?)(?:\bWHERE\b|`)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const setClause = m[1];
    if (/\bclosed_at\b/.test(setClause) || /\btakeover_state\b/.test(setClause)) {
      writes.push(setClause.replace(/\s+/g, ' ').trim());
    }
  }
  return writes;
}

describe('web_sessions closed_at / takeover_state writers', () => {
  const files = walk(path.join(SOURCE_ROOT, 'src'));

  it('finds the source tree (guards against a scanner that matches nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(sessionStateWrites(path.join(SOURCE_ROOT, ONLY_WRITER)).length).toBeGreaterThanOrEqual(3);
  });

  it('has exactly one file that writes either column', () => {
    const writers = files
      .filter((f) => sessionStateWrites(f).length > 0)
      .map((f) => path.relative(SOURCE_ROOT, f))
      .sort();
    if (writers.length !== 1 || writers[0] !== ONLY_WRITER) {
      throw new Error(
        `web_sessions.closed_at / takeover_state must be written only by ${ONLY_WRITER}, found:\n`
        + writers.map((w) => `  ${w}`).join('\n')
        + '\n\nA raw UPDATE of either column opens or ends a session without its takeover\n'
        + 'hold. Route it through startTakeover / endTakeover / closeSession, which\n'
        + 'write the session state and the hold in one transaction.',
      );
    }
    expect(writers).toEqual([ONLY_WRITER]);
  });
});
