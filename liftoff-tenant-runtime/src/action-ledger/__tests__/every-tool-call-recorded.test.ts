// Every place the runtime finishes a tool call records it. EVERY place.
//
// This started as a check over `agent-execution/service.ts`, because that is
// where the recorder was first wired — and it passed while an interactive chat
// turn recorded nothing at all, since a chat turn runs neither the autonomous
// loop nor the workflow-step one. A ratchet scoped to the file you already
// fixed confirms the fix and says nothing about the defect.
//
// So it scans the tree. The property is "an agent remembers what it did,
// whichever loop it did it in", and the only honest way to assert that is to
// find every loop rather than the ones already known about.
//
// Asserted over source because it is about COVERAGE of handlers: a new handler
// added without the call passes every behavioural test that drives the old ones.
//
// EXEMPTING ONE. Put `LEDGER_OBSERVER_ONLY:` with a reason in the handler. Some
// handlers watch a run rather than being one — a pure event→frame translator, a
// harness collecting a trace over a run that `executeTask` already records — and
// recording in those would double-count one action. The marker is what makes
// that a decision a reviewer can question rather than an omission nobody can
// tell from one.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every `case 'tool_call_finished'` in the tree, with the body up to the next
 *  case label — so a recorder call further down the switch cannot vouch for a
 *  handler that lacks one. */
function handlers(): Array<{ file: string; index: number; body: string }> {
  const found: Array<{ file: string; index: number; body: string }> = [];
  for (const file of tsFilesUnder(SRC)) {
    const src = readFileSync(file, 'utf8');
    const parts = src.split(/case 'tool_call_finished':/).slice(1);
    parts.forEach((part, i) => {
      found.push({
        file: file.slice(SRC.length + 1),
        index: i + 1,
        body: part.split(/\n\s*case '/)[0],
      });
    });
  }
  return found;
}

describe('the action ledger sees every finished tool call', () => {
  const all = handlers();

  it('finds handlers in more than one file, so this cannot pass vacuously', () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(new Set(all.map((h) => h.file)).size).toBeGreaterThanOrEqual(2);
  });

  it('records from every one of them', () => {
    // `rememberExternalToolCall` is the one function that records (the ledger
    // row and the provenance record together); `recordExternalToolCall` is
    // the ledger half, for a handler that calls it directly.
    const missing = all
      .filter((h) => !/rememberExternalToolCall|recordExternalToolCall/.test(h.body))
      .filter((h) => !h.body.includes('LEDGER_OBSERVER_ONLY'))
      .map((h) => `${h.file} handler #${h.index}`);

    expect(missing).toEqual([]);
  });
});
