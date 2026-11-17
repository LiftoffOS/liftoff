// The redaction the settings card reads back.
//
// These are the same assertions Liftoff-React's
// src/mocks/handlers/tenants.aiProviderKeys.test.ts makes against its mock. The
// card renders whatever the server sends verbatim, so if the two ever produce
// different strings the mock stops describing the real endpoint and the card's
// own tests stop meaning anything.

import { looksLikeHint, maskApiKey } from '../types';

const ANTHROPIC_KEY = 'sk-ant-api03-not-a-real-key-3f2x';
const OPENAI_KEY = 'sk-proj-not-a-real-key-9qLm';

describe('maskApiKey', () => {
  it('produces the exact hint the card is written against', () => {
    expect(maskApiKey(ANTHROPIC_KEY)).toBe('sk-ant••••••••3f2x');
    expect(maskApiKey(OPENAI_KEY)).toBe('sk-pro••••••••9qLm');
    expect(maskApiKey('sk-proj-rotated-key-7ttZ')).toBe('sk-pro••••••••7ttZ');
  });

  it('keeps only the vendor prefix and the tail; the interior never comes back', () => {
    const hint = maskApiKey(ANTHROPIC_KEY)!;
    expect(hint).not.toBe(ANTHROPIC_KEY);
    expect(hint).not.toContain('api03');
    expect(hint).not.toContain('not-a-real-key');
  });

  it('is a fixed width, so it does not disclose how long the key was', () => {
    const short = maskApiKey(ANTHROPIC_KEY)!;
    const long = maskApiKey(`${ANTHROPIC_KEY}-and-then-some-more`)!;
    expect(long).toHaveLength(short.length);
  });

  it('refuses to claim a key is stored when it is too short to redact', () => {
    // Below the threshold the head and tail overlap and hand back most of the
    // string. No real provider key is anywhere near this short.
    expect(maskApiKey('abc')).toBeNull();
    expect(maskApiKey('  ')).toBeNull();
    expect(maskApiKey('sk-short-1')).toBeNull();
  });

  it('trims before measuring, so a pasted key with whitespace still redacts', () => {
    expect(maskApiKey(`  ${ANTHROPIC_KEY}  `)).toBe('sk-ant••••••••3f2x');
  });
});

describe('looksLikeHint', () => {
  it('recognises our own redaction coming back as a key', () => {
    // Storing a hint as a key destroys the real credential and the customer has
    // no way to tell, so the endpoint refuses one rather than accepting it.
    expect(looksLikeHint(maskApiKey(ANTHROPIC_KEY)!)).toBe(true);
  });

  it('does not flag a real key', () => {
    expect(looksLikeHint(ANTHROPIC_KEY)).toBe(false);
    expect(looksLikeHint(OPENAI_KEY)).toBe(false);
  });
});
