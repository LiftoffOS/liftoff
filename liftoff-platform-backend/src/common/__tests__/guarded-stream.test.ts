// Deltas in, a person's text out: nothing leaves before its paragraph has
// been scrubbed and read, fences are scrubbed and never rewritten, order is
// kept whatever order the reads finish in, and a stop flushes what is held.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { GuardedOutput } from '../guarded-stream';
import type { OutputGuardContext, OutputGuardResult } from '../output-guard';

const CTX: OutputGuardContext = { tenantId: 'tenant-1', speaker: 'liftoff' };
const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';

/** A guard that records what it was asked to read and rewrites on request. */
function fakeGuard(rewrite: (text: string) => string | null = () => null) {
  const seen: string[] = [];
  const guard = async (text: string): Promise<OutputGuardResult> => {
    seen.push(text);
    const out = rewrite(text);
    return out === null ? { text, changed: false, kinds: [] } : { text: out, changed: true, kinds: ['mechanics'] };
  };
  return { guard, seen };
}

function collect() {
  const out: string[] = [];
  return { out, onText: (t: string) => out.push(t) };
}

describe('GuardedOutput', () => {
  it('holds a paragraph until its blank line, scrubs it, reads it, then delivers it whole', async () => {
    const { guard, seen } = fakeGuard();
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('The Support Triage team (id ');
    g.feed(`${ID}) ran the most.`);
    await Promise.resolve();
    expect(out).toEqual([]);
    g.feed('\n\nAhead of the ');
    g.feed('two others.');
    await g.flush();

    expect(seen).toEqual(['The Support Triage team ran the most.', 'Ahead of the two others.']);
    expect(out).toEqual(['The Support Triage team ran the most.\n\n', 'Ahead of the two others.']);
  });

  it('delivers the rewrite, not the first form, with the paragraph\'s whitespace put back', async () => {
    const { guard } = fakeGuard((t) => (t.includes('per the request') ? 'I added the note.' : null));
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('I added the note, per the request.\n\n');
    g.feed('Anything else?');
    await g.flush();

    expect(out.join('')).toBe('I added the note.\n\nAnything else?');
  });

  it('keeps order when a later paragraph is read faster than an earlier one', async () => {
    const holds = new Map<string, () => void>();
    const guard = (text: string) => new Promise<OutputGuardResult>((resolve) => {
      holds.set(text, () => resolve({ text, changed: false, kinds: [] }));
    });
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('First.\n\nSecond.\n\nThird.');
    const done = g.flush();
    await Promise.resolve();
    holds.get('Third.')!();
    holds.get('Second.')!();
    await Promise.resolve();
    expect(out).toEqual([]);
    holds.get('First.')!();
    await done;

    expect(out).toEqual(['First.\n\n', 'Second.\n\n', 'Third.']);
  });

  it('passes a fenced block through scrubbed and unread, and reads the prose around it', async () => {
    const { guard, seen } = fakeGuard(() => 'REWRITTEN');
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('Here is the chart:\n```visualization\n{"team":"Support Triage","id":"');
    g.feed(`${ID}","tasks":48}\n`);
    g.feed('```\nThat is all.');
    await g.flush();

    expect(seen).toEqual(['Here is the chart:', 'That is all.']);
    expect(out).toEqual([
      'REWRITTEN\n',
      '```visualization\n{"team":"Support Triage","id":"","tasks":48}\n```\n',
      'REWRITTEN',
    ]);
    const json = /```visualization\n([\s\S]*?)\n```/.exec(out[1])![1];
    expect(JSON.parse(json)).toEqual({ team: 'Support Triage', id: '', tasks: 48 });
  });

  it('keeps a double-underscore token inside a code fence and removes it outside', async () => {
    const { guard } = fakeGuard();
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('I used github__list_pull_requests.\n\n```python\nuser__name = 1\n```\n');
    await g.flush();

    expect(out.join('')).toBe('I used.\n\n```python\nuser__name = 1\n```\n');
  });

  it('does not open a fence on a partial fence line, and closes one only on a whole closing line', async () => {
    const { guard, seen } = fakeGuard();
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('Code:\n``');
    await Promise.resolve();
    expect(out).toEqual([]);
    g.feed('`\nx = 1\n``');
    g.feed('`\nDone.');
    await g.flush();

    expect(seen).toEqual(['Code:', 'Done.']);
    expect(out).toEqual(['Code:\n', '```\nx = 1\n```\n', 'Done.']);
  });

  it('passes a citations block through unread and scrubbed, and reads the sentence before it', async () => {
    const { guard, seen } = fakeGuard(() => 'REWRITTEN');
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('The NDA expires in June [1].\n<CITATIONS>[{"ref":1,"filename":"nda.pdf","quote":"expires ');
    g.feed(`June (id ${ID})"}]</CITATIONS>`);
    await g.flush();

    expect(seen).toEqual(['The NDA expires in June [1].']);
    expect(out).toEqual([
      'REWRITTEN\n',
      '<CITATIONS>[{"ref":1,"filename":"nda.pdf","quote":"expires June"}]</CITATIONS>',
    ]);
  });

  it('removes the turn\'s own tool names', async () => {
    const { guard, seen } = fakeGuard();
    const { onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard, toolNames: ['team_update'] });

    g.feed('I will call `team_update` with the handle.');
    await g.flush();

    expect(seen).toEqual(['I will call with the handle.']);
  });

  it('cuts a paragraph that never ends at a line end past the cap', async () => {
    const { guard, seen } = fakeGuard();
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    const row = '| a | b |\n';
    const table = row.repeat(700);
    g.feed(table);
    expect(seen.length).toBeGreaterThan(0);
    await g.flush();

    expect(out.join('')).toBe(table);
    for (const s of seen) expect(s.length).toBeLessThanOrEqual(6000);
  });

  it('flushes what is held on a stop, an unclosed fence included, and delivers nothing for whitespace', async () => {
    const { guard, seen } = fakeGuard();
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard });

    g.feed('Half a par');
    await g.flush();
    expect(out).toEqual(['Half a par']);

    g.feed('```\nunfinished');
    await g.flush();
    expect(out).toEqual(['Half a par', '```\nunfinished']);
    expect(seen).toEqual(['Half a par']);

    g.feed('\n\n');
    await g.flush();
    expect(out).toEqual(['Half a par', '```\nunfinished', '\n\n']);
  });

  it('keeps the segments behind a receiver that throws', async () => {
    const { guard } = fakeGuard();
    const out: string[] = [];
    const g = new GuardedOutput(CTX, {
      guard,
      onText: (t) => {
        if (t.startsWith('First')) throw new Error('closed');
        out.push(t);
      },
    });

    g.feed('First.\n\nSecond.');
    await g.flush();
    expect(out).toEqual(['Second.']);
  });

  it('falls back to the scrubbed text when a guard seam rejects', async () => {
    const { out, onText } = collect();
    const g = new GuardedOutput(CTX, { onText, guard: () => Promise.reject(new Error('down')) });

    g.feed(`Run ${ID} finished.`);
    await g.flush();
    expect(out).toEqual(['Run finished.']);
  });
});
