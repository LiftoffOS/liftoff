/**
 * Phase 3 — template.ts tests: happy paths, JSON-safe substitution,
 * adversarial payloads, size caps, escape handling.
 */

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { substitute, applyTemplate, resolveLoopCollection } from '../template';
import { TemplateResolutionError } from '../types';

describe('Phase 3 — substitute', () => {
  describe('happy paths', () => {
    it('substitutes {{input.X}} from context', () => {
      const result = substitute(
        '{"channel": {{input.channel}}}',
        { input: { channel: 'general' } },
      );
      expect(JSON.parse(result)).toEqual({ channel: 'general' });
    });

    it('substitutes {{output.X}} from context', () => {
      const result = substitute(
        '{"id": {{output.customer.id}}}',
        { output: { customer: { id: 'c123' } } },
      );
      expect(JSON.parse(result)).toEqual({ id: 'c123' });
    });

    it('substitutes {{item.X}} for loop bodies', () => {
      const result = substitute(
        '{"email": {{item.email}}}',
        { item: { email: 'a@b.com' } },
      );
      expect(JSON.parse(result)).toEqual({ email: 'a@b.com' });
    });

    it('substitutes multiple variables', () => {
      const result = substitute(
        '{"to": {{input.email}}, "subject": {{output.summary}}}',
        { input: { email: 'x@y.com' }, output: { summary: 'Report' } },
      );
      const parsed = JSON.parse(result);
      expect(parsed.to).toBe('x@y.com');
      expect(parsed.subject).toBe('Report');
    });

    it('substitutes numbers without quoting', () => {
      const result = substitute(
        '{"count": {{output.total}}}',
        { output: { total: 42 } },
      );
      expect(JSON.parse(result)).toEqual({ count: 42 });
    });

    it('substitutes booleans', () => {
      const result = substitute(
        '{"active": {{input.flag}}}',
        { input: { flag: true } },
      );
      expect(JSON.parse(result)).toEqual({ active: true });
    });

    it('substitutes null', () => {
      const result = substitute(
        '{"value": {{output.missing}}}',
        { output: { missing: null } },
      );
      expect(JSON.parse(result)).toEqual({ value: null });
    });
  });

  describe('JSON-safe substitution (security)', () => {
    it('escapes quote characters in string values to prevent JSON injection', () => {
      // An attacker-controlled value tries to break out of the JSON string
      const result = substitute(
        '{"channel": {{input.channel}}}',
        { input: { channel: 'general"}, "evil": "injected' } },
      );
      // The value must be properly escaped — no sibling injection
      const parsed = JSON.parse(result);
      expect(parsed.channel).toBe('general"}, "evil": "injected');
      expect(parsed.evil).toBeUndefined();
    });

    it('handles backslashes in values', () => {
      const result = substitute(
        '{"path": {{input.path}}}',
        { input: { path: 'C:\\Users\\file' } },
      );
      expect(JSON.parse(result).path).toBe('C:\\Users\\file');
    });

    it('handles newlines in values', () => {
      const result = substitute(
        '{"text": {{input.msg}}}',
        { input: { msg: 'line1\nline2' } },
      );
      expect(JSON.parse(result).text).toBe('line1\nline2');
    });
  });

  // These four pin that an unresolvable placeholder is refused rather than
  // rendered as `null`. Inside a JSON string — `{"id":"{{input.threadId}}"}`,
  // which is how an author naturally writes an id — `null` is the
  // four-character STRING "null", which is schema-valid, passes every check,
  // and would reach Gmail as a message id. Substitution refuses to invent a
  // value.
  describe('missing values', () => {
    it('throws for an undefined context root rather than inventing a value', () => {
      expect(() => substitute('{"x": {{item.val}}}', {}))
        .toThrow(TemplateResolutionError);
    });

    it('throws for an undefined nested path', () => {
      expect(() => substitute('{"x": {{output.missing.deep}}}', { output: { other: 1 } }))
        .toThrow(TemplateResolutionError);
    });

    it('carries the full reference so recovery can name what was missing', () => {
      expect(() => substitute('{"id":"{{input.threadId}}"}', { input: { message: {} } }))
        .toThrow(expect.objectContaining({ reference: 'input.threadId' }));
    });

    it('does NOT emit the string "null" into a JSON string literal', () => {
      // The regression this whole change exists to prevent, asserted directly:
      // whatever happens, the four characters must not reach the vendor as an id.
      let rendered: string | null = null;
      try {
        rendered = substitute('{"id":"{{input.threadId}}"}', { input: {} });
      } catch {
        rendered = null;
      }
      expect(rendered).not.toBe('{"id":"null"}');
    });
  });

  describe('literal escaping', () => {
    it('renders \\{\\{ as literal {{', () => {
      const result = substitute('prefix \\{\\{ suffix', {}, { jsonContext: false });
      expect(result).toBe('prefix {{ suffix');
    });
  });

  describe('size caps', () => {
    it('throws on template source exceeding 16KB', () => {
      const huge = 'x'.repeat(17 * 1024);
      expect(() => substitute(huge, {})).toThrow(/source exceeds/);
    });

    it('throws on output exceeding 64KB', () => {
      // A template that expands a value to a huge string
      const bigValue = 'x'.repeat(65 * 1024);
      expect(() => substitute(
        '{"data": {{input.big}}}',
        { input: { big: bigValue } },
      )).toThrow(/output exceeds/);
    });
  });

  // The security property is unchanged and now stated more strongly: a
  // forbidden segment never walks the prototype chain, and the template fails
  // rather than emitting anything at all for it.
  describe('prototype-pollution hardening (via getByPath)', () => {
    it('refuses a __proto__ path', () => {
      expect(() => substitute('{"x": {{input.__proto__.polluted}}}', { input: {} }))
        .toThrow(TemplateResolutionError);
    });

    it('refuses a constructor path', () => {
      expect(() => substitute('{"x": {{output.constructor.constructor}}}', { output: {} }))
        .toThrow(TemplateResolutionError);
    });
  });
});

describe('Phase 3 — applyTemplate', () => {
  it('returns static toolInput when no template', () => {
    const result = applyTemplate(
      { toolInput: { key: 'val' } },
      {},
    );
    expect(result).toEqual({ key: 'val' });
  });

  it('merges template output with static toolInput (static wins on conflict)', () => {
    const result = applyTemplate(
      {
        toolInput: { override: 'static' },
        toolInputTemplate: '{"override": {{input.val}}, "extra": {{input.more}}}',
      },
      { input: { val: 'dynamic', more: 'added' } },
    );
    expect(result.override).toBe('static'); // static wins
    expect(result.extra).toBe('added');     // template adds
  });

  it('throws on invalid JSON after substitution', () => {
    expect(() => applyTemplate(
      { toolInputTemplate: 'not json {{{input.x}}}' },
      { input: { x: 'v' } },
    )).toThrow(/invalid JSON/i);
  });
});

// ── loop.over must use the SAME addressing as every other field ──────────
//
// `loop.over` went straight to `getByPath(stepOutput, over)`, so it accepted
// only a bare path relative to the previous step's output — while the
// distiller's schema and the loop.collect comment in shared-types both describe
// stepId-keyed addressing. Loops authored against the documented model could
// not resolve:
//
//   s8  "{{steps.s5.findings}}" → stepOutput["{{steps"]
//   s3  "output.plan.channels"  → stepOutput["output"]
//
// A review agent would then publish a summary announcing "Blocking issues: 1"
// with nothing attached to the diff.
describe('resolveLoopCollection', () => {
  const ctx = {
    input: { message: { ids: ['m1', 'm2'] } },
    output: { plan: { channels: ['#eng', '#ops'] }, items: [1, 2, 3] },
    steps: { s5: { findings: [{ file: 'a.ts', line: 3 }, { file: 'b.ts', line: 9 }] } },
  };

  it('resolves the documented placeholder form', () => {
    expect(resolveLoopCollection('{{steps.s5.findings}}', ctx))
      .toEqual([{ file: 'a.ts', line: 3 }, { file: 'b.ts', line: 9 }]);
  });

  it('resolves a rooted path', () => {
    expect(resolveLoopCollection('output.plan.channels', ctx)).toEqual(['#eng', '#ops']);
  });

  it('still resolves a bare path against the previous step, as it always did', () => {
    // Back-compat: this is the only form that ever worked, and existing graphs
    // and tests rely on it.
    expect(resolveLoopCollection('items', ctx)).toEqual([1, 2, 3]);
  });

  it('reaches the trigger payload too', () => {
    expect(resolveLoopCollection('{{input.message.ids}}', ctx)).toEqual(['m1', 'm2']);
  });

  it('resolves the bare stepId-keyed form the distiller now documents', () => {
    expect(resolveLoopCollection('steps.s5.findings', ctx))
      .toEqual([{ file: 'a.ts', line: 3 }, { file: 'b.ts', line: 9 }]);
  });

  it('THROWS on output.<stepId>.<field>, which is not a map of steps', () => {
    // The form the distiller's schema used to document, so graphs authored
    // against it carry it: `output` is bound to
    // the PREVIOUS step's output, so this walks s5Output["s5"]["findings"] and
    // finds nothing. Pinned here so the schema fix cannot quietly regress into
    // teaching a path the executor cannot read.
    expect(() => resolveLoopCollection('output.s5.findings', ctx))
      .toThrow(TemplateResolutionError);
  });

  it('round-trips an empty collection as an empty array, not a miss', () => {
    // Zero findings is a real answer and must run the body zero times WITHOUT
    // being reported as an unresolved reference.
    expect(resolveLoopCollection('{{steps.s5.findings}}', { steps: { s5: { findings: [] } } }))
      .toEqual([]);
  });

  it('THROWS on an unresolvable reference rather than returning undefined', () => {
    // This is what makes the failure honest. The hybrid loop treats a
    // TemplateResolutionError as a contract defect and routes it to recovery
    // instead of the author's onFailure branch — a loop whose collection never
    // resolved ran its body zero times, so the step never happened.
    expect(() => resolveLoopCollection('{{steps.s5.missing}}', ctx))
      .toThrow(TemplateResolutionError);
    expect(() => resolveLoopCollection('nonexistent', ctx))
      .toThrow(TemplateResolutionError);
  });

  it('names the reference in the error, so recovery can see which one', () => {
    try {
      resolveLoopCollection('{{steps.s5.missing}}', ctx);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as TemplateResolutionError).reference).toBe('steps.s5.missing');
    }
  });

  it('does not invent a second addressing model', () => {
    // Two answers to "what does steps.s5 mean" is how the validator and the
    // executor drifted apart before. Everything routes through `substitute`.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'template.ts'), 'utf8',
    ) as string;
    const at = src.indexOf('export function resolveLoopCollection');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at);
    expect(body).toContain('substitute(expr, context');
    expect(body).not.toContain('getByPath(');
  });
});

