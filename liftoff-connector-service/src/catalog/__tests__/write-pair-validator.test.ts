// Tests for the staged-write pairing validator, and for the declarations the
// registry actually carries.
//
// The pairing half mirrors work-pair-validator.test.ts: every violation kind
// fires on its triggering shape, and a clean registry returns [].
//
// The declaration half is the one worth reading. `idArgs` names arguments, and
// an argument name that does not exist on the tool's own input schema is a
// declaration that can never match — the runtime looks for it, finds nothing,
// and treats the write as "declared no id arguments", which is the same state
// as not being covered at all. A typo there is invisible in every direction
// except this one.

import type { ConnectorFunction } from '../../types';
import {
  assertNoWritePairViolations,
  validateWritePairs,
} from '../write-pair-validator';
import {
  getConnectorFunctions,
  getRegisteredConnectorTypes,
} from '../connector-functions-registry';
import { loadReviewedIdArgs } from '../reviewed-id-args';

function fn(over: Partial<ConnectorFunction> & { name: string }): ConnectorFunction {
  const { name, ...rest } = over;
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    categories: ['write'],
    ...rest,
  };
}

describe('validateWritePairs — clean registries', () => {
  it('returns empty for an empty registry', () => {
    expect(validateWritePairs({})).toEqual([]);
  });

  it('returns empty when nothing opts in', () => {
    // Every tool in the estate today. `writeRole` unset is 'direct', and a
    // direct write is paired with nothing.
    expect(validateWritePairs({
      x: [fn({ name: 'send_message' }), fn({ name: 'update_row' })],
    })).toEqual([]);
  });

  it('accepts a complete stage/apply pair', () => {
    expect(validateWritePairs({
      pricing: [
        fn({ name: 'stage_price_update', writeRole: 'stage', paired_apply: 'apply_price_update' }),
        fn({ name: 'apply_price_update', writeRole: 'apply' }),
      ],
    })).toEqual([]);
  });

  it('accepts an explicit direct', () => {
    expect(validateWritePairs({ x: [fn({ name: 'send', writeRole: 'direct' })] })).toEqual([]);
  });
});

describe('validateWritePairs — violations', () => {
  it('fails a stage with no apply named', () => {
    // The failure that drops work: the batch is prepared, the person approves
    // it, and nothing commits.
    const v = validateWritePairs({ x: [fn({ name: 'stage_it', writeRole: 'stage' })] });

    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe('stage_missing_paired_apply');
    expect(v[0].detail).toContain('silently dropped');
  });

  it('fails a stage whose apply does not resolve', () => {
    const v = validateWritePairs({
      x: [fn({ name: 'stage_it', writeRole: 'stage', paired_apply: 'commit_it' })],
    });

    expect(v.map((x) => x.reason)).toContain('paired_apply_not_found_in_connector');
  });

  it('fails a stage whose target is not an apply', () => {
    const v = validateWritePairs({
      x: [
        fn({ name: 'stage_it', writeRole: 'stage', paired_apply: 'other' }),
        fn({ name: 'other', writeRole: 'direct' }),
      ],
    });

    expect(v.map((x) => x.reason)).toContain('paired_apply_target_has_wrong_role');
  });

  it('fails an apply nothing stages for', () => {
    // The half that can commit a write nobody approved.
    const v = validateWritePairs({ x: [fn({ name: 'apply_it', writeRole: 'apply' })] });

    expect(v.map((x) => x.reason)).toContain('apply_declared_without_a_stage');
  });

  it('fails a pairing on a tool that stages nothing', () => {
    // Reads in the source exactly like a working declaration and does nothing:
    // the runtime only follows paired_apply from a stage.
    const v = validateWritePairs({
      x: [
        fn({ name: 'send', paired_apply: 'apply_it' }),
        fn({ name: 'apply_it', writeRole: 'apply' }),
      ],
    });

    expect(v.map((x) => x.reason)).toContain('paired_apply_set_without_stage_role');
  });

  it('fails a role no consumer matches on', () => {
    const v = validateWritePairs({
      x: [fn({ name: 'x', writeRole: 'commit' as unknown as ConnectorFunction['writeRole'] })],
    });

    expect(v[0].reason).toBe('unknown_write_role');
  });
});

describe('assertNoWritePairViolations', () => {
  it('exits non-zero and names each violation', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    assertNoWritePairViolations(
      validateWritePairs({ x: [fn({ name: 'stage_it', writeRole: 'stage' })] }),
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join('\n')).toContain('x.stage_it');
    exit.mockRestore();
    error.mockRestore();
  });
});

describe('the live registry', () => {
  const registry = Object.fromEntries(
    getRegisteredConnectorTypes().map((t) => [t, getConnectorFunctions(t)]),
  );

  it('has no half-declared staged-write pair', () => {
    expect(validateWritePairs(registry)).toEqual([]);
  });

  it('names only arguments the tool actually accepts in idArgs', () => {
    // The check the declaration cannot get by without. `idArgs: ['pull_number']`
    // on a tool whose argument is `pullNumber` is not an error anywhere: the
    // runtime looks the key up, finds nothing, and reads the write as
    // "declares no id arguments" — indistinguishable from a tool that was never
    // covered. Every declared name has to exist on the schema it belongs to.
    const wrong: string[] = [];
    for (const [type, fns] of Object.entries(registry)) {
      for (const f of fns) {
        const props = Object.keys(f.inputSchema?.properties ?? {});
        for (const arg of f.idArgs ?? []) {
          if (!props.includes(arg)) wrong.push(`${type}.${f.name} → idArgs '${arg}' (has: ${props.join(', ')})`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it('declares an entityType on every tool that says what its result returns', () => {
    // `returnsIds` pairs an entity type with a path, and the entity type is what
    // stops a message id vouching for a pull request. An empty one silently
    // downgrades every match to the untyped fallback.
    const wrong: string[] = [];
    for (const [type, fns] of Object.entries(registry)) {
      for (const f of fns) {
        for (const r of f.returnsIds ?? []) {
          if (!r.entityType || !r.path) wrong.push(`${type}.${f.name} → ${JSON.stringify(r)}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it('a hand-written idArgs comes with the returnsIds its author could see', () => {
    // `idArgs` on a write says "judge this call against what the run has seen".
    // `returnsIds` on a read says "these are the ids the run has now seen".
    //
    // This used to refuse every connector with the first and not the second,
    // on the reasoning that nothing in such a connector could ever provenance
    // a write. That stopped being true when the runtime's heuristic floor
    // landed: the floor records the id-shaped values of EVERY read that passes
    // the gateway, declared or not, and the judge matches declared arguments
    // against them. A connector with reviewed `idArgs` and no `returnsIds` is
    // therefore judged precisely on the write side and heuristically on the
    // read side — strictly better than the floor alone, which is what an
    // undeclared connector gets — and its precise read side arrives through the
    // learned-shapes queue, which is the only source that can see a response.
    //
    // What the rule still catches is the case it was written for: a PERSON
    // writing `idArgs` into this registry by hand has the connector open and
    // can see what its reads return, and a half-declaration from that person
    // is unfinished work. The generated declarations cannot say what a read
    // returns and are not held to it. Checked here rather than only in
    // composio-overlays because this is where the native and overlay halves
    // merge.
    const generated = loadReviewedIdArgs().declarations;
    const halfDeclared: string[] = [];
    for (const [type, fns] of Object.entries(registry)) {
      const reviewed = new Set(Object.keys(generated[type] ?? {}));
      const judgedByHand = fns.some((f) => (f.idArgs ?? []).length > 0 && !reviewed.has(f.name));
      const sources = fns.some((f) => (f.returnsIds ?? []).length > 0);
      if (judgedByHand && !sources) halfDeclared.push(type);
    }

    expect(halfDeclared).toEqual([]);
  });

  it('covers the connectors the runtime has write rules for', () => {
    // A guard on the guard: if the declarations were dropped or the arrays
    // renamed, every assertion above would pass vacuously.
    const declared = Object.entries(registry)
      .filter(([, fns]) => fns.some((f) => (f.idArgs ?? []).length > 0))
      .map(([type]) => type);

    expect(declared).toEqual(expect.arrayContaining(['slack', 'gitlab', 'google_mail']));
  });
});
