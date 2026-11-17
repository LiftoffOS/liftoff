/**
 * R5 Fix 8 scrub-logger tests. Verifies:
 *   - BE-R5-004: arrays are recursed and sensitive string items scrubbed
 *   - BE-R5-005: circular refs produce '[Circular]' instead of RangeError
 *   - sensitive fields (args, stdout, stderr, error) scrubbed
 *   - non-sensitive primitives pass through
 */
import { scrubLogFields } from '../scrub-logger';

const TESTONLY_SECRET = 'sk-ant-TESTONLY_NOTASECRET_ABC123def456ghi789jkl012mno345pqr67';

describe('scrubLogFields', () => {
  it('scrubs a string in a sensitive top-level field', () => {
    const out = scrubLogFields({ stdout: `leak: ${TESTONLY_SECRET}` });
    expect(out.stdout).toContain('[REDACTED:anthropic-api-key]');
    expect(out.stdout).not.toContain(TESTONLY_SECRET);
  });

  it('BE-R5-004: recurses into arrays and scrubs sensitive string elements', () => {
    const out = scrubLogFields({
      args: ['git', 'clone', '--token', TESTONLY_SECRET],
    });
    const argsOut = out.args as unknown[];
    expect(argsOut).toContain('git');
    expect(argsOut).toContain('clone');
    expect(argsOut).toContain('--token');
    // The secret should be replaced in the array slot
    const last = argsOut[argsOut.length - 1] as string;
    expect(last).toContain('[REDACTED:anthropic-api-key]');
  });

  it('BE-R5-005: handles circular references without stack overflow', () => {
    const obj: Record<string, unknown> = { event: 'test' };
    obj.self = obj;
    // Must not throw RangeError. The function visits obj once, recurses, and
    // on the inner visit sees it's already in `seen` and emits '[Circular]'.
    const out = scrubLogFields(obj);
    expect(out).toBeDefined();
    const inner = out.self as { self: unknown };
    expect(inner.self).toBe('[Circular]');
  });

  it('scrubs nested objects recursively', () => {
    const out = scrubLogFields({
      nested: {
        stdout: `secret: ${TESTONLY_SECRET}`,
      },
    });
    const nested = out.nested as { stdout: string };
    expect(nested.stdout).toContain('[REDACTED');
    expect(nested.stdout).not.toContain(TESTONLY_SECRET);
  });

  it('passes through non-string, non-object fields unchanged', () => {
    const out = scrubLogFields({
      count: 42,
      flag: true,
      nullv: null,
    });
    expect(out.count).toBe(42);
    expect(out.flag).toBe(true);
    expect(out.nullv).toBe(null);
  });

  it('passes through non-sensitive string fields unchanged', () => {
    const out = scrubLogFields({ event: 'test_event', tenantId: '123e4567-e89b-12d3-a456-426614174000' });
    expect(out.event).toBe('test_event');
    expect(out.tenantId).toBe('123e4567-e89b-12d3-a456-426614174000');
  });
});
