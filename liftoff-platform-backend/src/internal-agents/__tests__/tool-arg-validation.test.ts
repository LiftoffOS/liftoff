// Lossless coercion of authored tool arguments.
//
// `parseAuthoredArgs` collapses every placeholder to `{{P}}` and keeps no
// offsets, which is fine for validating and useless for repairing: nothing maps
// a parsed leaf back to its token, distinct placeholders become one, and a bare
// `{{steps.s1.total}}` comes back quoted. So a value the schema states plainly
// is the wrong TYPE of — `post_at` authored as a number where the tool wants a
// string — was a tool_input_mismatch and a whole regeneration of the artifact.
//
// tokenizeTemplate / coerceToolArgs / restoreTemplate let the template be
// edited as data and written back with every placeholder byte-identical. The
// tests here pin the three properties that make that safe: the round trip is
// the identity when nothing is coerced, every coercion preserves the value,
// and no placeholder ever moves or changes form.

import {
  tokenizeTemplate,
  coerceToolArgs,
  restoreTemplate,
  parseAuthoredArgs,
  validateToolArgs,
  PLACEHOLDER_SENTINEL_PREFIX,
} from '../tool-arg-validation';
import { __internalValidateWorkflowSteps as validateWorkflowSteps, type ToolCatalog } from '../distill-service';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** tokenize → (no change) → restore. */
function roundTrip(template: string): string | undefined {
  const t = tokenizeTemplate(template);
  if (!t) return undefined;
  return restoreTemplate(JSON.parse(t.json), t.tokens);
}

/** Placeholders of a template, in order, with their bare/quoted form. */
function placeholderForms(template: string): Array<{ original: string; bare: boolean }> {
  const t = tokenizeTemplate(template);
  if (!t) throw new Error(`untokenisable: ${template}`);
  return t.tokens.map(({ original, bare }) => ({ original, bare }));
}

describe('tokenizeTemplate / restoreTemplate is the identity on placeholders', () => {
  it('zero placeholders', () => {
    const t = '{"a":1,"b":"two","c":[true,null]}';
    expect(roundTrip(t)).toBe(t);
    expect(tokenizeTemplate(t)?.tokens).toEqual([]);
  });

  it('one placeholder, quoted', () => {
    const t = '{"thread_id":"{{input.message.threadId}}"}';
    expect(roundTrip(t)).toBe(t);
    expect(placeholderForms(t)).toEqual([{ original: '{{input.message.threadId}}', bare: false }]);
  });

  it('one placeholder, bare', () => {
    const t = '{"count":{{steps.s1.total}}}';
    expect(roundTrip(t)).toBe(t);
    expect(placeholderForms(t)).toEqual([{ original: '{{steps.s1.total}}', bare: true }]);
  });

  it('three placeholders, mixed forms, each restored where it was and as it was', () => {
    const t = '{"path":"{{item.path}}","line":{{item.line}},"body":"see {{steps.s2.note}} now"}';
    expect(roundTrip(t)).toBe(t);
    expect(placeholderForms(t)).toEqual([
      { original: '{{item.path}}', bare: false },
      { original: '{{item.line}}', bare: true },
      { original: '{{steps.s2.note}}', bare: false },
    ]);
  });

  it('honours an escaped quote inside a string, so the placeholder after it is still in-string', () => {
    const t = '{"body":"say \\"hi\\" to {{input.message.from}}","n":{{steps.s1.n}}}';
    expect(roundTrip(t)).toBe(t);
    expect(placeholderForms(t)).toEqual([
      { original: '{{input.message.from}}', bare: false },
      { original: '{{steps.s1.n}}', bare: true },
    ]);
  });

  it('keeps a placeholder adjacent to a quoted sentinel-looking substring', () => {
    // `"__LIFTOFF_PH_"` inside the template makes the tokenisation ambiguous,
    // so the template is refused rather than guessed at; a LOOKALIKE that is
    // not the prefix is ordinary text and round-trips.
    const lookalike = '{"k":"__LIFTOFF_PX_0__","v":"{{steps.s1.v}}"}';
    expect(roundTrip(lookalike)).toBe(lookalike);
    const ambiguous = `{"k":"${PLACEHOLDER_SENTINEL_PREFIX}0__","v":"{{steps.s1.v}}"}`;
    expect(tokenizeTemplate(ambiguous)).toBeUndefined();
  });

  it('returns undefined for a template no substitution can parse', () => {
    expect(tokenizeTemplate('{"connector":')).toBeUndefined();
    expect(tokenizeTemplate('{"a":{{x}}')).toBeUndefined();
  });

  it('restore returns undefined when a coercion lost a placeholder', () => {
    const t = tokenizeTemplate('{"a":{{steps.s1.a}}}')!;
    expect(restoreTemplate({ a: 1 }, t.tokens)).toBeUndefined();
    const q = tokenizeTemplate('{"a":"{{steps.s1.a}}"}')!;
    expect(restoreTemplate({ a: 'gone' }, q.tokens)).toBeUndefined();
  });

  it('parses to the same data parseAuthoredArgs sees, with distinct placeholders kept distinct', () => {
    const t = '{"a":"{{steps.s1.x}}","b":"{{steps.s2.y}}"}';
    const parsed = JSON.parse(tokenizeTemplate(t)!.json);
    expect(parsed.a).not.toBe(parsed.b);
    const collapsed = parseAuthoredArgs(t) as Record<string, string>;
    expect(collapsed.a).toBe(collapsed.b);
  });
});

describe('coerceToolArgs — each coercion, value-preserving', () => {
  const schema = {
    type: 'object',
    properties: {
      post_at: { type: 'string' },
      count: { type: 'number' },
      page: { type: 'integer' },
      dry: { type: 'boolean' },
      labels: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object', properties: { id: { type: 'string' } } },
      ids: { type: 'array', items: { type: 'integer' } },
    },
    required: ['post_at'],
  };

  it('number → string for a string property', () => {
    const { args, coercions } = coerceToolArgs(schema, { post_at: 1700000000 });
    expect(args).toEqual({ post_at: '1700000000' });
    expect(coercions).toEqual([{ path: '/post_at', from: 'number', to: 'string' }]);
  });

  it('numeric string → number for a number property', () => {
    const { args, coercions } = coerceToolArgs(schema, { post_at: 'x', count: '12.5' });
    expect(args).toEqual({ post_at: 'x', count: 12.5 });
    expect(coercions).toEqual([{ path: '/count', from: 'string', to: 'number' }]);
  });

  it('integral numeric string → number for an integer property; a fraction is left alone', () => {
    expect(coerceToolArgs(schema, { post_at: 'x', page: '3' }).args).toEqual({ post_at: 'x', page: 3 });
    const frac = coerceToolArgs(schema, { post_at: 'x', page: '3.5' });
    expect(frac.args).toEqual({ post_at: 'x', page: '3.5' });
    expect(frac.coercions).toEqual([]);
  });

  it("'true' / 'false' → boolean for a boolean property", () => {
    expect(coerceToolArgs(schema, { post_at: 'x', dry: 'true' }).args).toEqual({ post_at: 'x', dry: true });
    expect(coerceToolArgs(schema, { post_at: 'x', dry: 'false' }).args).toEqual({ post_at: 'x', dry: false });
    // Any other string is not a boolean and is not guessed at.
    expect(coerceToolArgs(schema, { post_at: 'x', dry: 'yes' }).coercions).toEqual([]);
  });

  it('scalar → [scalar] for an array property', () => {
    const { args, coercions } = coerceToolArgs(schema, { post_at: 'x', labels: 'inbox' });
    expect(args).toEqual({ post_at: 'x', labels: ['inbox'] });
    expect(coercions).toEqual([{ path: '/labels', from: 'string', to: 'array' }]);
  });

  it('recurses into nested objects and array items', () => {
    const { args, coercions } = coerceToolArgs(schema, { post_at: 'x', nested: { id: 42 }, ids: ['1', '2'] });
    expect(args).toEqual({ post_at: 'x', nested: { id: '42' }, ids: [1, 2] });
    expect(coercions.map((c) => c.path).sort()).toEqual(['/ids/0', '/ids/1', '/nested/id']);
  });

  it('does not mutate its input', () => {
    const input = { post_at: 1700000000, nested: { id: 7 } };
    coerceToolArgs(schema, input);
    expect(input).toEqual({ post_at: 1700000000, nested: { id: 7 } });
  });
});

describe('coerceToolArgs — what it must not touch', () => {
  const schema = {
    type: 'object',
    properties: {
      post_at: { type: 'string' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      count: { type: 'number' },
      maybe: { type: ['string', 'null'] },
    },
    required: ['post_at', 'count'],
  };

  it('a placeholder, in either form', () => {
    const t = tokenizeTemplate('{"post_at":{{steps.s1.when}},"count":"{{steps.s1.n}}"}')!;
    const parsed = JSON.parse(t.json);
    const { args, coercions } = coerceToolArgs(schema, parsed);
    expect(coercions).toEqual([]);
    expect(args).toEqual(parsed);
    // Object form: the placeholder is a string carrying `{{`.
    expect(coerceToolArgs(schema, { post_at: 'x', count: '{{steps.s1.n}}' }).coercions).toEqual([]);
  });

  it('an unknown key is carried, never dropped', () => {
    const { args, coercions } = coerceToolArgs(schema, { post_at: 'x', count: 1, extra: '9' });
    expect(args).toEqual({ post_at: 'x', count: 1, extra: '9' });
    expect(coercions).toEqual([]);
  });

  it('an enum value is never substituted', () => {
    const { args, coercions } = coerceToolArgs(schema, { post_at: 'x', count: 1, mode: 'medium' });
    expect(args).toEqual({ post_at: 'x', count: 1, mode: 'medium' });
    expect(coercions).toEqual([]);
    // The validator still says so.
    expect(validateToolArgs(schema, args).map((p) => p.message).join(' ')).toContain('mode');
  });

  it('a missing required value is never invented', () => {
    const { args, coercions } = coerceToolArgs(schema, { post_at: 'x' });
    expect(args).toEqual({ post_at: 'x' });
    expect(coercions).toEqual([]);
    expect(validateToolArgs(schema, args).map((p) => p.message).join(' ')).toContain('MISSING required: count');
  });

  it('a string containing {{ anywhere', () => {
    const { coercions } = coerceToolArgs(schema, { post_at: 'x', count: 'about {{steps.s1.n}} items' });
    expect(coercions).toEqual([]);
  });

  it('a union type', () => {
    const { coercions } = coerceToolArgs(schema, { post_at: 'x', count: 1, maybe: 5 });
    expect(coercions).toEqual([]);
  });

  it('a schema with no properties, or arguments that are not an object', () => {
    expect(coerceToolArgs({ type: 'object' }, { a: 1 }).coercions).toEqual([]);
    expect(coerceToolArgs(schema, 'nope').coercions).toEqual([]);
    expect(coerceToolArgs(undefined, { post_at: 1 }).coercions).toEqual([]);
  });
});

// ── Evaluation ────────────────────────────────────────────────────────────
//
// The property the whole thing exists for: after a coercion, the RESOLVED
// arguments the runtime would dispatch are the same as before at every path
// but the coerced ones, and at those the value has the schema's type. Checked
// by substituting a fixture context into the authored and the restored
// templates the way the runtime would, and comparing what parses.
describe('evaluation against a fixture context', () => {
  const context: Record<string, unknown> = {
    'input.message.threadId': 'thr_1',
    'steps.s1.total': 42,
    'steps.s2.note': 'all good',
    'item.path': 'src/a.ts',
    'item.line': 7,
  };

  /** Test-only resolver: a bare placeholder becomes its JSON, an in-string one
   *  its text — the runtime's two substitution modes. */
  function resolve(template: string): unknown {
    const t = tokenizeTemplate(template)!;
    let out = template;
    for (const tok of t.tokens) {
      const key = tok.original.slice(2, -2).trim();
      const value = context[key];
      out = out.replace(tok.original, tok.bare ? JSON.stringify(value) : String(value));
    }
    return JSON.parse(out);
  }

  function parentPaths(template: string): string[] {
    // The JSON pointer of each placeholder's PARENT, read from the tokenised
    // document so the check is independent of the templates' whitespace.
    const t = tokenizeTemplate(template)!;
    const doc = JSON.parse(t.json);
    const found: Record<string, string> = {};
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'string' && v.includes(PLACEHOLDER_SENTINEL_PREFIX)) {
        found[v] = path.slice(0, path.lastIndexOf('/'));
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}/${i}`));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`);
      }
    };
    walk(doc, '');
    return t.tokens.map((tok) => found[Object.keys(found).find((k) => k.includes(`${PLACEHOLDER_SENTINEL_PREFIX}${tok.n}__`))!]);
  }

  it('changes only the coerced paths, to the schema type, and moves no placeholder', () => {
    const schema = {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        post_at: { type: 'string' },
        max: { type: 'integer' },
        total: { type: 'number' },
        meta: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' }, flag: { type: 'boolean' } } },
      },
    };
    const authored = '{"thread_id":"{{input.message.threadId}}","post_at":1700000000,"max":"5","total":{{steps.s1.total}},"meta":{"path":"{{item.path}}","line":{{item.line}},"flag":"true"}}';

    const t = tokenizeTemplate(authored)!;
    const { args, coercions } = coerceToolArgs(schema, JSON.parse(t.json));
    const restored = restoreTemplate(args, t.tokens)!;
    expect(coercions.map((c) => c.path).sort()).toEqual(['/max', '/meta/flag', '/post_at']);

    const before = resolve(authored) as Record<string, unknown>;
    const after = resolve(restored) as Record<string, unknown>;

    // Coerced paths carry the schema's type now.
    expect(typeof after.post_at).toBe('string');
    expect(typeof after.max).toBe('number');
    expect(typeof (after.meta as Record<string, unknown>).flag).toBe('boolean');
    // ...and the same value.
    expect(after.post_at).toBe(String(before.post_at));
    expect(after.max).toBe(Number(before.max));
    expect((after.meta as Record<string, unknown>).flag).toBe(true);

    // Everything else is deep-equal.
    const strip = (o: Record<string, unknown>) => ({
      thread_id: o.thread_id, total: o.total,
      meta: { path: (o.meta as Record<string, unknown>).path, line: (o.meta as Record<string, unknown>).line },
    });
    expect(strip(after)).toEqual(strip(before));

    // Every placeholder is still under the parent it was authored under, in
    // the same order and the same form.
    expect(parentPaths(restored)).toEqual(parentPaths(authored));
    expect(placeholderForms(restored)).toEqual(placeholderForms(authored));
  });
});

// ── Property test ─────────────────────────────────────────────────────────
//
// Generated templates: random nesting, random placeholders in both forms,
// random literals of every JSON type, against a schema that asks for a
// different type at random paths. restore(coerce(tokenize(t))) must preserve
// the multiset of placeholder tokens and each one's bare/quoted form, and must
// tokenise again.
describe('property: restore(coerce(tokenize(t))) preserves every placeholder and its form', () => {
  // Deterministic PRNG so a failure is reproducible from its seed.
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ROOTS = ['steps.s1.a', 'steps.s2.b', 'input.message.id', 'item.x', 'output.y'];
  const TYPES = ['string', 'number', 'integer', 'boolean', 'array'];

  function generate(rand: () => number, depth = 0): { text: string; schema: Record<string, unknown> } {
    const keys = Math.floor(rand() * 4) + 1;
    const parts: string[] = [];
    const props: Record<string, unknown> = {};
    for (let i = 0; i < keys; i++) {
      const key = `k${i}`;
      const roll = rand();
      const want = TYPES[Math.floor(rand() * TYPES.length)];
      let value: string;
      if (roll < 0.25) {
        value = `{{${ROOTS[Math.floor(rand() * ROOTS.length)]}}}`; // bare placeholder
      } else if (roll < 0.5) {
        value = `"pre {{${ROOTS[Math.floor(rand() * ROOTS.length)]}}} post"`; // in-string
      } else if (roll < 0.6 && depth < 2) {
        const inner = generate(rand, depth + 1);
        props[key] = { type: 'object', properties: inner.schema };
        parts.push(`"${key}":${inner.text}`);
        continue;
      } else if (roll < 0.7) {
        value = String(Math.floor(rand() * 1000));
      } else if (roll < 0.8) {
        value = `"${Math.floor(rand() * 1000)}"`;
      } else if (roll < 0.9) {
        value = rand() < 0.5 ? '"true"' : 'false';
      } else {
        value = '"say \\"hi\\""';
      }
      props[key] = { type: want };
      parts.push(`"${key}":${value}`);
    }
    return { text: `{${parts.join(',')}}`, schema: props };
  }

  it('holds over 300 generated templates', () => {
    const rand = prng(20260917);
    for (let i = 0; i < 300; i++) {
      const { text, schema } = generate(rand);
      const before = placeholderForms(text);
      const t = tokenizeTemplate(text)!;
      const { args } = coerceToolArgs({ type: 'object', properties: schema }, JSON.parse(t.json));
      const restored = restoreTemplate(args, t.tokens);
      expect(restored).toBeDefined();
      expect(placeholderForms(restored!)).toEqual(before);
      // And the multiset, independent of order.
      expect([...placeholderForms(restored!)].sort((a, b) => a.original.localeCompare(b.original)))
        .toEqual([...before].sort((a, b) => a.original.localeCompare(b.original)));
    }
  });
});

// ── Placement ─────────────────────────────────────────────────────────────
//
// The coercion runs INSIDE validateWorkflowSteps, before validateToolArgs, and
// writes back onto the step: the artifact the validators judge is the one the
// run persists, so a repair that reached only a local copy would be re-done on
// every attempt and never ship.
describe('placement: applied before the judgment, in place, idempotent', () => {
  const catalog: ToolCatalog = new Map([
    ['slack__schedule', {
      name: 'slack__schedule', description: 'schedule a message',
      input_schema: {
        type: 'object',
        properties: { channel: { type: 'string' }, post_at: { type: 'string' }, text: { type: 'string' } },
        required: ['channel', 'post_at', 'text'],
      },
    }],
  ]);

  it('a template with post_at authored as a number passes as a string, keeping its placeholders', () => {
    const step = {
      stepId: 's1', type: 'tool_call', description: 'd', toolName: 'slack__schedule',
      toolInputTemplate: '{"channel":"{{input.channel}}","post_at":1700000000,"text":"{{steps.s2.body}}"}',
    } as never;
    const errs = validateWorkflowSteps([step], catalog);
    expect(errs.filter((e) => e.type === 'tool_input_mismatch')).toEqual([]);
    const after = (step as { toolInputTemplate: string }).toolInputTemplate;
    expect(after).toContain('"post_at":"1700000000"');
    expect(placeholderForms(after)).toEqual([
      { original: '{{input.channel}}', bare: false },
      { original: '{{steps.s2.body}}', bare: false },
    ]);
    // A second pass finds nothing to do and changes nothing.
    validateWorkflowSteps([step], catalog);
    expect((step as { toolInputTemplate: string }).toolInputTemplate).toBe(after);
  });

  it('the object form is coerced in place too', () => {
    const step = {
      stepId: 's1', type: 'tool_call', description: 'd', toolName: 'slack__schedule',
      toolInput: { channel: 'C1', post_at: 1700000000, text: '{{steps.s2.body}}' },
    } as never;
    const errs = validateWorkflowSteps([step], catalog);
    expect(errs.filter((e) => e.type === 'tool_input_mismatch')).toEqual([]);
    expect((step as { toolInput: Record<string, unknown> }).toolInput).toEqual({
      channel: 'C1', post_at: '1700000000', text: '{{steps.s2.body}}',
    });
  });

  it('keeps the authored template when nothing is coerced', () => {
    const authored = '{"channel":"C1","post_at":"1700000000","text":"hi"}';
    const step = {
      stepId: 's1', type: 'tool_call', description: 'd', toolName: 'slack__schedule', toolInputTemplate: authored,
    } as never;
    validateWorkflowSteps([step], catalog);
    expect((step as { toolInputTemplate: string }).toolInputTemplate).toBe(authored);
  });

  it('still reports a mismatch no coercion can repair', () => {
    const step = {
      stepId: 's1', type: 'tool_call', description: 'd', toolName: 'slack__schedule',
      toolInputTemplate: '{"channel":"C1","post_at":{"nested":true},"text":"hi"}',
    } as never;
    const errs = validateWorkflowSteps([step], catalog);
    expect(errs.filter((e) => e.type === 'tool_input_mismatch')).toHaveLength(1);
    expect(errs[0].field).toBe('toolInputTemplate');
  });
});
