import { sanitizeArgs } from '../service';

describe('sanitizeArgs — Layer 1 (key-name kill, regression)', () => {
  it('redacts a key named password', () => {
    expect(sanitizeArgs({ password: 'hunter2' }))
      .toEqual({ password: '[REDACTED]' });
  });

  it.each(['token', 'secret', 'apikey', 'api_key', 'auth_token', 'credential'])(
    'redacts %p key wholesale without inspecting value',
    (k) => {
      const result = sanitizeArgs({ [k]: 'anything' }) as Record<string, unknown>;
      expect(result[k]).toBe('[REDACTED]');
    },
  );
});

describe('sanitizeArgs — Layer 2 (value-level pattern scan)', () => {
  it('redacts SSN inside a free-text notes field', () => {
    const result = sanitizeArgs({ notes: 'Employee SSN: 123-45-6789' });
    expect(result).toEqual({ notes: 'Employee SSN: [REDACTED_SSN]' });
  });

  it('redacts email inside a nested object', () => {
    const result = sanitizeArgs({
      tool_call: { args: { payload: 'contact alice@example.com' } },
    });
    expect((result as any).tool_call.args.payload)
      .toBe('contact [REDACTED_EMAIL]');
  });

  it('redacts credit card inside an array of objects', () => {
    const result = sanitizeArgs([
      { description: 'card 4111 1111 1111 1111 expires 12/30' },
    ]);
    expect((result as any[])[0].description).toContain('[REDACTED_CC]');
  });

  it('passes primitives through unchanged', () => {
    expect(sanitizeArgs({
      count: 42, active: true, deleted_at: null,
    })).toEqual({
      count: 42, active: true, deleted_at: null,
    });
  });

  it('Layer 1 wins over Layer 2 — credential key never has value scanned', () => {
    // The value happens to also match the SSN pattern, but the key is killed
    // wholesale by Layer 1 before any pattern run.
    const result = sanitizeArgs({ auth_token: '123-45-6789' });
    expect(result).toEqual({ auth_token: '[REDACTED]' });
  });

  it('does not mutate the input', () => {
    const input = { notes: 'SSN 123-45-6789' };
    sanitizeArgs(input);
    expect(input.notes).toBe('SSN 123-45-6789');
  });
});

describe('sanitizeArgs — truncation', () => {
  it('truncates strings longer than MAX_VALUE_LENGTH after redaction', () => {
    const long = 'x'.repeat(1500);
    const result = sanitizeArgs({ blob: long });
    expect((result as any).blob).toHaveLength(1000 + '...[truncated]'.length);
    expect((result as any).blob.endsWith('...[truncated]')).toBe(true);
  });
});
