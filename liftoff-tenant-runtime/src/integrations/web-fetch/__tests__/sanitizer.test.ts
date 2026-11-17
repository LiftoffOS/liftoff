import { sanitizeWebContent } from '../sanitizer';

describe('tenant-runtime sanitizeWebContent', () => {
  it('strips ChatML, Claude XML, ANSI, HTML comments', () => {
    const dirty = '<|im_start|>x<|im_end|><system>y</system>\x1B[31mz\x1B[0m<!--c-->';
    expect(sanitizeWebContent(dirty)).toBe('xyz');
  });

  it('preserves Hebrew/Arabic letters and role-colon prefixes', () => {
    expect(sanitizeWebContent('שלום')).toBe('שלום');
    expect(sanitizeWebContent('System: x')).toBe('System: x');
  });

  it('is idempotent', () => {
    const once = sanitizeWebContent('<system>x</system>');
    expect(sanitizeWebContent(once)).toBe(once);
  });
});
