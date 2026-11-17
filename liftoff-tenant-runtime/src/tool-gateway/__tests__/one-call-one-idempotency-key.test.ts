// A model-issued tool call is its own act, and the key has to say so.
//
// `actions.idempotency_key` is UNIQUE, and the gateway answers a COMPLETED
// match with the stored response instead of dispatching. So a key that carries
// only the trace and the tool NAME makes every call to that tool in one run the
// same act: the first writes a ledger row, and the rest either leave no record
// of what they did or are answered with the first call's result.
//
// One step that makes six `create_document_markdown` calls — a watch list, a
// snapshot and four battle cards — leaves ONE ledger row for them, and five
// documents in the customer's Drive that the duplicate guard, the undo path and
// the acts-this-run prompt block cannot see. One model-issued route in
// `mcp-server.ts` without the per-call discriminator is enough (the Composio
// route was that route) — so this is asserted over every route rather than
// that one.
//
// Why source rather than behaviour: the property is about a VALUE CONSTRUCTED at
// each of nine registration sites, and the failure is one site being written
// without it. Booting the server per route would exercise the sites that exist
// today and say nothing about the next one added.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf8');

/** Every `idempotencyKey:` assignment in the file, with the expression it is
 *  given — up to the next property, so a multi-line ternary is captured whole. */
function keyAssignments(): Array<{ at: number; expr: string }> {
  const out: Array<{ at: number; expr: string }> = [];
  for (const m of SRC.matchAll(/idempotencyKey:/g)) {
    const at = m.index ?? 0;
    // The assignment ends at the next line whose first token is a property name
    // followed by a colon, which is where the object literal moves on.
    const rest = SRC.slice(at + 'idempotencyKey:'.length, at + 2600);
    const end = rest.search(/\n\s+[a-zA-Z_][\w]*:/);
    out.push({ at, expr: end === -1 ? rest : rest.slice(0, end) });
  }
  return out;
}

describe('one model-issued call is one act', () => {
  it('finds the registration sites, so this is not vacuous', () => {
    expect(keyAssignments().length).toBeGreaterThanOrEqual(8);
  });

  it('every per-run key carries a per-call discriminator', () => {
    const offenders: string[] = [];
    for (const { at, expr } of keyAssignments()) {
      // Strip comments: the prose explaining a key names the shapes it is not.
      const code = expr
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // A key built off the trace is a PER-RUN key and needs the discriminator.
      // Three other shapes are complete on their own and are not per-run:
      //   stepKey(...)       hashes the arguments
      //   idemKey            resolved by the caller
      //   a fixed singleton  one call per run by construction (a context hint,
      //                      a value offload — keyed by the path it is for)
      if (!code.includes('${traceId}')) continue;
      const perRunHalf = code.slice(code.indexOf('${traceId}'));
      const discriminated = perRunHalf.includes('toolIndex++')
        // Keyed by a value unique to the call rather than a counter.
        || /\$\{(path|idemKey)\}/.test(perRunHalf);
      if (!discriminated) {
        offenders.push(SRC.slice(at, at + 120).split('\n').slice(0, 3).join(' ').trim());
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Composio route — the one that carries most of the traffic — has it', () => {
    // Named explicitly because it is the site that was wrong, and a rewrite of
    // the scan above must not quietly stop covering it.
    expect(SRC).toContain('`${traceId}-mcp-composio-${toolName}-${toolIndex++}`');
  });
});
