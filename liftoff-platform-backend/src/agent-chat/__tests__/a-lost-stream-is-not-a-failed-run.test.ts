/**
 * A stream ending is not a run ending.
 *
 * The runtime does not stop when the connection does. ADR-041 is explicit that
 * a client disconnect leaves the turn running, and the engine is cancelled only
 * by the durable abort row. So a read that fails, or a stream that ends without
 * a terminal frame, says NOTHING about the run.
 *
 * Reporting it as a failure is badly misleading:
 *
 *   - a person can be told "This run stopped on an error before it could
 *     answer. It reached step N of M" while the run works on for minutes more;
 *   - a run can get the same sentence, then park, continue, and write its
 *     result into the document it had been asked to write.
 *
 * In both cases the work is fine and only the account of it is wrong — and
 * "Trying again is safe" invites a second run on top of a first that is still
 * going.
 *
 * Asserted on the SOURCE because the branches sit inside a generator whose
 * other paths need a full runtime; the behavioural half lives in
 * `chat-service-sdk.test.ts`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'chat-service.ts'), 'utf8');

describe('neither lost-stream branch claims the run failed', () => {
  it('the no-terminal-frame branch yields stream_lost', () => {
    const at = SRC.indexOf('A STREAM ENDING IS NOT A RUN ENDING');
    expect(at).toBeGreaterThan(-1);
    // Bounded to this branch's OWN yield. A fixed window swept in the
    // pre-stream branch below, which keeps PROVIDER_ERROR on purpose.
    const yieldAt = SRC.indexOf("yield { type: 'stream_lost'", at);
    expect(yieldAt).toBeGreaterThan(at);
    const branch = SRC.slice(at, yieldAt);
    expect(branch).not.toMatch(/code: 'PROVIDER_ERROR'/);
    expect(branch).not.toMatch(/stopped before sending/);
  });

  it('the mid-stream-throw branch yields stream_lost', () => {
    const at = SRC.indexOf('the read failed, the');
    expect(at).toBeGreaterThan(-1);
    const branch = SRC.slice(at, at + 600);
    expect(branch).toContain("yield { type: 'stream_lost'");
    expect(branch).not.toMatch(/code: 'PROVIDER_ERROR'/);
  });

  it('logs at warn, not error: nothing is known to be wrong with the run', () => {
    const at = SRC.indexOf('chat turn stream ended without a terminal frame');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at - 200, at)).toContain('log.warn');
  });

  it('keeps PROVIDER_ERROR for the case that IS about reaching the runtime', () => {
    // A connection that failed BEFORE any streaming never started a run, so
    // there is nothing still going and an error is the honest answer. Narrowing
    // this fix past that would hide a real failure.
    expect(SRC).toContain('We could not reach the agent right now.');
  });
});

describe('the copy says what is true', () => {
  const copy = SRC.match(/const STREAM_ENDED_RUN_CONTINUES =\s*\n?\s*'([^']+)'/)![1];

  it('names the connection, not the run, as the thing that ended', () => {
    expect(copy).toMatch(/connection/i);
    expect(copy).not.toMatch(/stopped/i);
  });

  it('says the run continues and the result will land here', () => {
    expect(copy).toMatch(/still going/i);
    expect(copy).toMatch(/appear here|result/i);
  });

  it('does not invite a second run on top of the first', () => {
    expect(copy).not.toMatch(/try again|retry|safe/i);
  });

  it('follows the product voice', () => {
    expect(copy).not.toMatch(/—/);
    expect(copy).not.toMatch(/\b\w+'(s|t|re|ll|ve|d)\b/);
    expect(copy.toLowerCase()).not.toMatch(/\bagent\b/);
  });
});

describe('the tracker is NOT settled by a lost stream', () => {
  it('persists through persistProgressLine, never persistRunEnded', () => {
    // `persistRunEnded` settles the tracker as the run's last word. This run
    // has not had its last word: the outcome arrives on the settle callback
    // and that is what gets to write it.
    const at = SRC.indexOf("if (event.type === 'stream_lost' && turnExists)");
    expect(at).toBeGreaterThan(-1);
    const branch = SRC.slice(at, at + 300);
    expect(branch).toContain('persistProgressLine(input, event.detail)');
    expect(branch).not.toContain('persistRunEnded');
    expect(branch).not.toContain('progress.settle()');
  });

  it('an actual error event still settles and reports, as before', () => {
    expect(SRC).toMatch(/if \(event\.type === 'error' && turnExists\) \{\s*\n\s*await persistRunEnded\(input, event, progress\);/);
  });
});
