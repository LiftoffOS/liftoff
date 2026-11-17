// Tests for the category boot validator.
//
// Two halves. The pure-function semantics, on fixtures; and the property that
// actually protects production — the LIVE registry passes, so the assertion at
// module load is a real gate rather than one that would take the service down
// on the next deploy.

import type { ConnectorFunction } from '../../types';
import {
  KNOWN_CATEGORIES,
  validateCategories,
  assertNoCategoryViolations,
} from '../category-validator';
import {
  getConnectorFunctions,
  getRegisteredConnectorTypes,
} from '../connector-functions-registry';

function fn(over: Partial<ConnectorFunction> & { name: string }): ConnectorFunction {
  const { name, ...rest } = over;
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    ...rest,
  };
}

describe('validateCategories — clean registries', () => {
  it('returns empty for an empty registry', () => {
    expect(validateCategories({})).toEqual([]);
  });

  it('accepts every category on the axis', () => {
    expect(
      validateCategories({
        x: [...KNOWN_CATEGORIES].map((c) =>
          fn({ name: `t_${c}`, categories: [c] as ConnectorFunction['categories'] }),
        ),
      }),
    ).toEqual([]);
  });

  it('accepts a function carrying several categories', () => {
    expect(
      validateCategories({
        x: [fn({ name: 'delete_row', categories: ['write', 'destructive'] })],
      }),
    ).toEqual([]);
  });
});

describe('validateCategories — violations', () => {
  it('fails a function that declares nothing', () => {
    // The case the assertion exists for: an axis that is present for most
    // entries and absent for a few is one every consumer keeps a fallback for.
    const violations = validateCategories({
      sheets: [fn({ name: 'append_values', categories: [] })],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      connectorType: 'sheets',
      toolName: 'append_values',
      reason: 'no_category',
    });
    // The message has to say what to do, not only that something is wrong.
    expect(violations[0].detail).toContain('read, write, destructive, outbound, sensitive');
  });

  it('fails a function whose categories field is missing entirely', () => {
    const violations = validateCategories({
      sheets: [{ name: 'x', description: '', inputSchema: { type: 'object', properties: {} } } as unknown as ConnectorFunction],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe('no_category');
  });

  it('fails a category no consumer matches on', () => {
    // A typo here is worse than an absence: it reads as declared and matches
    // nothing, so the tool silently behaves as though it had no category while
    // looking fully specified in the source.
    const violations = validateCategories({
      sheets: [fn({ name: 'read_values', categories: ['reed'] as unknown as ConnectorFunction['categories'] })],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ reason: 'unknown_category' });
    expect(violations[0].detail).toContain("'reed'");
  });

  it('reports every violation rather than stopping at the first', () => {
    const violations = validateCategories({
      a: [fn({ name: 'one', categories: [] }), fn({ name: 'two', categories: [] })],
      b: [fn({ name: 'three', categories: [] })],
    });

    expect(violations).toHaveLength(3);
    expect(violations.map((v) => v.toolName)).toEqual(['one', 'two', 'three']);
  });
});

describe('assertNoCategoryViolations', () => {
  it('does nothing when the registry is clean', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    assertNoCategoryViolations([]);

    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
    error.mockRestore();
  });

  it('exits non-zero and names each violation', () => {
    // The production posture: refuse to come up rather than serve a half
    // declared axis to the oversight filter.
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    assertNoCategoryViolations(
      validateCategories({ sheets: [fn({ name: 'append_values', categories: [] })] }),
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join('\n')).toContain('sheets.append_values');
    exit.mockRestore();
    error.mockRestore();
  });
});

describe('the live registry', () => {
  it('declares a category on every registered function', () => {
    // The gate is only real if the thing it gates already passes. Asserted over
    // the PUBLIC view, which is what the assertion at module load walks and what
    // the runtime actually serves: history tools are synthesized per connector
    // at read time and are not in the underlying map.
    const registry = Object.fromEntries(
      getRegisteredConnectorTypes().map((t) => [t, getConnectorFunctions(t)]),
    );

    expect(validateCategories(registry)).toEqual([]);
  });

  it('covers a registry big enough for the check to mean something', () => {
    // Guards against the previous assertion passing because the registry failed
    // to load and every connector came back empty.
    const total = getRegisteredConnectorTypes()
      .reduce((sum, t) => sum + getConnectorFunctions(t).length, 0);

    expect(getRegisteredConnectorTypes().length).toBeGreaterThan(100);
    expect(total).toBeGreaterThan(10_000);
  });
});
