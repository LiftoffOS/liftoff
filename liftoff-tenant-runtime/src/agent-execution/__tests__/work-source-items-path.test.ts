// A wrong `itemsPath` must not be able to switch an agent off.
//
// `itemsPath` is authored against a response shape nobody is shown — the tool
// catalog carries input schemas only — so the declared path is a guess. A wrong
// guess is expensive here: resolveCompanionWorkItems returns an error, the
// handler throws, a throw is a routine failure, and three routine failures
// auto-pause the AGENT and deregister its event trigger. A weekly sweep can
// switch off a working email trigger three Mondays running.
//
// For example, a companion can declare `itemsPath: "messages"` for Gmail's
// list_messages, whose envelope is `{"items": [...]}`.
//
// The fallback is deliberately narrow: exactly ONE array-valued property is not
// a guess, because there is no other candidate to choose between. With two, or
// none, it still errors — a real choice means picking is guessing again.
//
// Source-level: the function needs a live gateway, a catalog and a tenant to
// dispatch its listing tool.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

const block = SRC.slice(
  SRC.indexOf('let raw = getByPath(r.result, args.itemsPath);'),
  SRC.indexOf('const items = raw'),
);

describe('the single-array fallback', () => {
  it('exists and is reached only after the declared path misses', () => {
    expect(block.length).toBeGreaterThan(300);
    expect(block.indexOf('if (!Array.isArray(raw))')).toBeLessThan(block.indexOf('arrays.length === 1'));
  });

  it('collects array-valued properties from the result object', () => {
    expect(block).toContain('.filter(([, v]) => Array.isArray(v))');
  });

  it('uses the array only when there is exactly one', () => {
    // Two candidates is a real choice, and picking one would be the same guess
    // this exists to remove.
    expect(block).toContain('arrays.length === 1');
    expect(block).not.toContain('arrays.length > 0');
    expect(block).not.toContain('arrays[0] ?');
  });

  it('does not treat a bare array result as an envelope', () => {
    // `Object.entries` on an array yields its indices, which would make a
    // single-element array look like one "array-valued property".
    expect(block).toContain('!Array.isArray(r.result)');
  });

  it('records that it corrected the path, rather than silently papering over it', () => {
    // The declared path is still wrong and the graph should be fixed; a silent
    // rescue would hide that forever.
    expect(block).toContain('companion_work_source.items_path_corrected');
    expect(block).toContain('declaredPath');
    expect(block).toContain('resolvedPath');
  });

  it('still errors when nothing unambiguous is available', () => {
    const tail = SRC.slice(
      SRC.indexOf('let raw = getByPath(r.result, args.itemsPath);'),
      SRC.indexOf('const items = raw'),
    );
    expect(tail).toContain('result has no array at');
    // And that error still distinguishes "unreadable shape" from "no work".
    expect(tail).toMatch(/there is no work" are different facts/);
  });
});
