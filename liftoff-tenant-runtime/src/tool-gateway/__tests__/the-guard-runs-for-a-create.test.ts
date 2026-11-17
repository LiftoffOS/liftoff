/**
 * A create is guardable, and the gate in front of the guard has to agree.
 *
 * THREE gates sit between a dispatch and the duplicate check, and a create had
 * to clear all of them. Two were fixed and the third still bailed, so the
 * identity was computed, written onto the ledger row, and never read:
 *
 *   1. `actKeyFor`            — identifies a create by what it WRITES  ✓ fixed
 *   2. `findCompletedDuplicate` — matches on that key with no target   ✓ fixed
 *   3. `guardableTarget`      — `if (!target.ref) return null`         ✗ still bailed
 *
 * So one run can create the same watch list twice, seconds apart, with BOTH
 * ledger rows carrying the identical
 * `google-docs:create_document_markdown|#<digest>` key. The key is right.
 * Nothing asks it.
 *
 * That is the "wired at one end" shape: a fix that is correct everywhere it was
 * applied and absent in the one place the call actually passes through.
 */
import { duplicateKey } from '../duplicate-outward-action';
import { actKeyFor, directOperation, deriveTarget } from '../../action-ledger/target-ref';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

const CONNECTOR = 'google-docs-8fd9fc68';
const ACTION = 'create_document_markdown';
const targetFor = (payload: unknown) =>
  deriveTarget({ connector: CONNECTOR, actionType: ACTION, entityType: '', payload: payload as Record<string, unknown> });
const keyFor = (payload: unknown) =>
  actKeyFor(directOperation(CONNECTOR, ACTION), targetFor(payload), payload);

const WATCH_LIST = { title: 'Acme competitor watch list', markdown_text: '# Acme competitor watch list\n\nRecreated on this sweep\n' };

describe('the gate lets a target-less write reach the guard', () => {
  it('no longer bails when the act names nothing that exists yet', () => {
    const at = SERVICE.indexOf('private guardableTarget(');
    const fn = SERVICE.slice(at, at + 1_600);
    expect(fn).not.toMatch(/if \(!target\.ref\) return null;/);
    expect(fn).toContain('return deriveTarget(input);');
  });

  it('still refuses a sandbox tool and a read', () => {
    // The two exclusions that are about WHAT the act is, not whether it names
    // a target. Dropping those would guard things that are not outward writes.
    const at = SERVICE.indexOf('private guardableTarget(');
    const fn = SERVICE.slice(at, at + 1_600);
    expect(fn).toContain('isSandboxTool(input.actionType)) return null');
    expect(fn).toContain('if (!isWriteAction(input.actionType)) return null');
  });

  it('the serial path hands the content key to the lookup', () => {
    expect(SERVICE).toMatch(/findCompletedDuplicate\(input, target, actKeyFor\([\s\S]{0,120}?input\.payload\)\)/);
  });
});

describe('the batch key tells two different creates apart', () => {
  // The reason the gate could not simply stop bailing. `executeBatch` builds a
  // batch-local key from the TARGET, so with an empty ref every create of one
  // action type collapsed onto one key — suppressing the second as a duplicate
  // of a different document.
  const other = { title: 'Acme competitor snapshot', markdown_text: '# Snapshot\n' };

  it('two identical creates share a batch key', () => {
    expect(duplicateKey(ACTION, targetFor(WATCH_LIST), null, keyFor(WATCH_LIST)))
      .toBe(duplicateKey(ACTION, targetFor({ ...WATCH_LIST }), null, keyFor({ ...WATCH_LIST })));
  });

  it('two DIFFERENT creates do not', () => {
    expect(duplicateKey(ACTION, targetFor(WATCH_LIST), null, keyFor(WATCH_LIST)))
      .not.toBe(duplicateKey(ACTION, targetFor(other), null, keyFor(other)));
  });

  it('without the content key they would collide, which is what made the bail necessary', () => {
    // The old shape, shown failing: target.ref is empty for both, so the key
    // was identical for two unrelated documents.
    expect(duplicateKey(ACTION, targetFor(WATCH_LIST), null))
      .toBe(duplicateKey(ACTION, targetFor(other), null));
  });

  it('a TARGETED act still keys on its target, not its content', () => {
    // Editing the body of one document twice is the same act on the same
    // target, and must stay one key.
    const a = { document_id: 'doc-1', new_markdown_text: 'first' };
    const b = { document_id: 'doc-1', new_markdown_text: 'second' };
    const t = (p: unknown) => deriveTarget({ connector: CONNECTOR, actionType: 'update_document_markdown', entityType: '', payload: p as Record<string, unknown> });
    const k = (p: unknown) => actKeyFor(directOperation(CONNECTOR, 'update_document_markdown'), t(p), p);
    expect(duplicateKey('update_document_markdown', t(a), null, k(a)))
      .toBe(duplicateKey('update_document_markdown', t(b), null, k(b)));
  });

  it('the batch path passes it', () => {
    expect(SERVICE).toMatch(/duplicateKey\(\s*\n?\s*input\.actionType, guardTarget, multiplexedOperation\(input\.payload\),[\s\S]{0,300}?actKeyFor\(/);
  });
});
