// Every chat stream says when it has finished writing.
//
// `reader.read()` reporting `done` in the browser means the body ended. It does
// not say why, and the two reasons are opposites: the turn finished, or the
// connection was cut underneath it. The shared client (liftoff-react
// services/chatSse.ts) has no other way to tell them apart, so without an
// explicit marker a truncated stream resolves as a completed one and the person
// is told nothing — an indicator running with a dead socket behind it.
//
// Agent chat has always written this frame. The Liftoff assistant and the
// Insights Manager did not, so on those two surfaces the distinction did not
// exist at all.
//
// WHAT THIS FILE USED TO CHECK, AND WHY THAT WAS NOT ENOUGH. It read each
// router's source and looked for the literal frame bytes, a `finally`, and a
// `writableEnded` guard near them. All three assertions can pass on all three
// routers while the property fails: the bytes can be in each file, in a
// `finally`, correctly guarded — and an `interrupt_delivered` exit that ends the
// socket above the `try` that `finally` belongs to makes steering a running turn
// raise "The connection dropped before the reply finished arriving." every
// single time, on a message that HAD been delivered. Proving a write exists
// somewhere in a file says nothing about which exits reach it.
//
// So the frame is no longer written by the routers. `src/common/chat-stream.ts`
// owns it, the routers hold a ChatStream instead of a writable response, and
// chat-stream-terminal-frame.test.ts walks the AST to keep it that way — an exit
// that could skip the frame no longer exists to be found. What remains here is
// the seam this file was always about: each router still has to END its stream on
// the way out, and the wrapper still has to write the frame when it does.
//
// The CAIO's router lives in liftoff-workforce-service and carries the same
// frame; it cannot be reached from here, which is why this file names the
// property rather than trusting the file list to be complete.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROUTERS = [
  'agent-chat/stream-router.ts',
  'insights/stream-router.ts',
  'liftoff/stream-router.ts',
];

const WRAPPER = 'common/chat-stream.ts';

function read(file: string): string {
  return readFileSync(join(__dirname, '..', file), 'utf8');
}

describe('the terminal frame has one writer', () => {
  it('the wrapper writes it', () => {
    expect(read(WRAPPER)).toContain("event: done\\ndata: {}\\n\\n");
  });

  it('the wrapper writes it exactly once per stream', () => {
    // `end()` is called from a `finally` AND from a hard timeout that can fire
    // while the finally is running. Two terminal frames is not merely untidy: a
    // write after `res.end()` throws, inside a block that also releases the
    // turn lock, which would turn a client hanging up into a lock that never
    // came back.
    const source = read(WRAPPER);
    expect(source).toMatch(/if \(this\.closed\) return;\s*\n\s*this\.closed = true;/);
  });

  it('the wrapper does not write into a response that is already gone', () => {
    // There is nobody to tell, and the write would raise rather than inform.
    // The LAST mention is the write itself; the earlier ones are prose, and
    // reading the first was how the old version of this check found a guard that
    // was not there.
    const source = read(WRAPPER);
    const doneIdx = source.lastIndexOf('event: done');
    expect(doneIdx).toBeGreaterThan(-1);
    const guardIdx = source.lastIndexOf('writableEnded', doneIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(doneIdx - guardIdx).toBeLessThan(400);
  });

  it.each(ROUTERS)('%s writes no terminal frame of its own', file => {
    // One writer. A router spelling the bytes itself is a second implementation
    // of the property, which is how the first one drifted.
    //
    // The BYTES, not the phrase: each router documents `event: done` in its
    // header comment, because it is part of the vocabulary the client sees, and a
    // check that could not tell prose from a write would make documenting it a
    // failure. Anything the routers could write it WITH is caught by the AST
    // ratchet in chat-stream-terminal-frame.test.ts.
    expect(read(file)).not.toContain("event: done\\ndata: {}\\n\\n");
  });
});

describe('every chat stream marks its own clean close', () => {
  it.each(ROUTERS)('%s opens its stream through the wrapper', file => {
    expect(read(file)).toContain('openChatStream(res)');
  });

  it.each(ROUTERS)('%s ends it on the way out, not on the happy path only', file => {
    const source = read(file);
    // The close has to be reachable when the turn threw, timed out, or the
    // iterator ended early. Ending beside a `complete` would mean the one case
    // the client needs the frame for — an ending nobody planned — is the case it
    // never arrives in.
    const finallyIdx = source.lastIndexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(source.indexOf('stream.end()', finallyIdx)).toBeGreaterThan(finallyIdx);
  });

  it.each(ROUTERS)('%s closes every stream it opens, early exits included', file => {
    // The exits ABOVE the `try` are the ones that lost the frame — the greeting,
    // and the interrupt acknowledgment that answers a message folded into a
    // running turn. Each opens a stream of its own and each has to close it, so
    // the check is per BINDING rather than a count: a router that grew a fourth
    // exit and forgot it would otherwise still balance.
    const source = read(file);
    const names = [...source.matchAll(/const (\w+) = openChatStream\(res\);/g)].map(m => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(source).toContain(`${name}.end()`);
    }
  });
});
