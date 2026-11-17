// A new connector cannot land undeclared, and a generated declaration cannot be
// inert.
//
// The ratchet's shape is the usual one: existing gaps are frozen debt, anything
// NEW fails. What makes it worth having is the direction it can move — a
// connector that gains declarations must come off the list, so the baseline can
// only shrink.
//
// This is the counterpart to the runtime's heuristic floor. The floor gives
// every connector provenance memory whatever its declarations; this makes the
// PRECISION layer grow rather than staying at the three connectors somebody had
// time to hand-write.

import {
  getRegisteredConnectorTypes,
  getConnectorFunctions,
} from '../connector-functions-registry';
import {
  generateIdArgDeclarations,
  declarationIsSatisfiable,
} from '../declaration-generator';
import { KNOWN_UNDECLARED_CONNECTORS } from './known-undeclared-connectors';
import { loadReviewedIdArgs } from '../reviewed-id-args';

const registry = Object.fromEntries(
  getRegisteredConnectorTypes().map((t) => [t, getConnectorFunctions(t)]),
);

/** Connectors that have at least one write and therefore COULD be declared. */
const declarable = Object.entries(registry).filter(([, fns]) =>
  fns.some((f) => (f.categories ?? []).map(String).some((c) => ['write', 'destructive', 'outbound'].includes(c.toLowerCase()))),
);

describe('the declaration ratchet', () => {
  it('has no connector declared for the first time without coming off the baseline', () => {
    // Only tightens. A connector that gained declarations and stayed on the
    // list would make the baseline a permanent exemption for work already done.
    const stale = KNOWN_UNDECLARED_CONNECTORS.filter((type) =>
      (registry[type] ?? []).some((f) => (f.idArgs ?? []).length > 0));
    expect(stale).toEqual([]);
  });

  it('fails a NEW declarable connector that nobody declared or baselined', () => {
    const undeclared = declarable
      .filter(([, fns]) => !fns.some((f) => (f.idArgs ?? []).length > 0))
      .map(([type]) => type)
      .filter((type) => !KNOWN_UNDECLARED_CONNECTORS.includes(type));
    expect(undeclared).toEqual([]);
  });
});

describe('generated declarations are satisfiable by construction', () => {
  it('every proposal names arguments its own function accepts', () => {
    // Cannot fail while the names are read FROM the schema, which is the point.
    // Asserting it means a future generator that stops reading the schema is
    // caught rather than shipped.
    const bad: string[] = [];
    for (const [type, fns] of Object.entries(registry)) {
      for (const decl of generateIdArgDeclarations(type, fns)) {
        const fn = fns.find((f) => f.name === decl.functionName)!;
        if (!declarationIsSatisfiable(decl, fn)) bad.push(`${type}.${decl.functionName}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('never proposes for a READ', () => {
    // A read does not act on a record, and judging one would flag every lookup.
    for (const [type, fns] of Object.entries(registry)) {
      for (const decl of generateIdArgDeclarations(type, fns)) {
        const fn = fns.find((f) => f.name === decl.functionName)!;
        const cats = (fn.categories ?? []).map((c) => String(c).toLowerCase());
        expect(cats.some((c) => ['write', 'destructive', 'outbound'].includes(c))).toBe(true);
      }
    }
  });

  it('never overwrites a hand-written declaration', () => {
    // A generator that undid a human's correction on every regeneration is one
    // that stops anybody correcting.
    for (const [type, fns] of Object.entries(registry)) {
      const proposed = new Set(generateIdArgDeclarations(type, fns).map((d) => d.functionName));
      for (const fn of fns) {
        if ((fn.idArgs ?? []).length > 0) expect(proposed.has(fn.name)).toBe(false);
      }
    }
  });

  it('has been reviewed for the estate, so the assertions are not vacuous', () => {
    // The registry serves the reviewed file, so what the generator still
    // proposes is what nobody has reviewed. The file is where the coverage is.
    const reviewed = Object.values(loadReviewedIdArgs().declarations)
      .reduce((n, fns) => n + Object.keys(fns).length, 0);
    expect(reviewed).toBeGreaterThan(50);
  });

  it('leaves no proposal unreviewed: every write the generator proposes is in the file or rejected', () => {
    // The review loop closes here. A new write, or a new connector, produces a
    // proposal; `npm run propose:id-args` puts it in the file for the diff to
    // be read; and until someone has, this fails. A rejected function is a
    // decision too, and stays out.
    const { rejected = {} } = loadReviewedIdArgs();
    const unreviewed: string[] = [];
    for (const [type, fns] of Object.entries(registry)) {
      for (const decl of generateIdArgDeclarations(type, fns)) {
        if (!(rejected[type] ?? []).includes(decl.functionName)) unreviewed.push(`${type}.${decl.functionName}`);
      }
    }
    expect(unreviewed).toEqual([]);
  });
});

describe('the reviewed declarations', () => {
  const { declarations, rejected = {} } = loadReviewedIdArgs();

  it('name only functions the registry has, and only arguments they take', () => {
    // A reviewed name the schema has since dropped is a declaration naming
    // nothing, which reads downstream as "undeclared" and hides the drift.
    const dangling: string[] = [];
    for (const [type, fns] of Object.entries(declarations)) {
      for (const [name, idArgs] of Object.entries(fns)) {
        const fn = (registry[type] ?? []).find((f) => f.name === name);
        if (!fn) { dangling.push(`${type}.${name}: no such function`); continue; }
        const accepted = new Set(Object.keys(fn.inputSchema?.properties ?? {}));
        for (const a of idArgs) if (!accepted.has(a)) dangling.push(`${type}.${name}: no argument ${a}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('are served: a reviewed write carries its idArgs out of the registry', () => {
    const [type, fns] = Object.entries(declarations)[0];
    const [name, idArgs] = Object.entries(fns)[0];
    expect(registry[type].find((f) => f.name === name)?.idArgs).toEqual(idArgs);
  });

  it('never sit beside a hand-written declaration for the same function', () => {
    // The registry's own `idArgs` wins and the file's entry would be dead
    // weight that looks like coverage. The proposal script cannot produce one
    // — the generator skips declared functions — so one here was hand-added.
    // (Checked against the source list rather than the served one, which
    // already carries the file's names.)
    const overlap: string[] = [];
    for (const [type, fns] of Object.entries(declarations)) {
      for (const name of Object.keys(fns)) {
        if ((rejected[type] ?? []).includes(name)) overlap.push(`${type}.${name}: both reviewed and rejected`);
      }
    }
    expect(overlap).toEqual([]);
  });
});
