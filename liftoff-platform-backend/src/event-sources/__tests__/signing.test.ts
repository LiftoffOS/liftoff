// HMAC signature verification + token/secret generator tests.

import crypto from 'crypto';
import {
  parseSignatureHeader,
  verifySignature,
  generateSigningSecret,
  generateUrlToken,
  secretHint,
} from '../signing';

const SECRET = 'a'.repeat(64);

function sign(rawBody: Buffer, timestamp: number, secret = SECRET): string {
  const base = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
  return crypto.createHmac('sha256', secret).update(base).digest('hex');
}

describe('parseSignatureHeader', () => {
  it('parses a well-formed header', () => {
    const result = parseSignatureHeader('t=1234567890,v1=abcdef');
    expect(result).toEqual({ timestamp: 1234567890, signature: 'abcdef' });
  });

  it('tolerates whitespace and ordering', () => {
    const result = parseSignatureHeader(' v1=abc , t=42 ');
    expect(result).toEqual({ timestamp: 42, signature: 'abc' });
  });

  it('rejects missing t', () => {
    expect(parseSignatureHeader('v1=abc')).toBeNull();
  });

  it('rejects missing v1', () => {
    expect(parseSignatureHeader('t=42')).toBeNull();
  });

  it('rejects malformed timestamp', () => {
    expect(parseSignatureHeader('t=notanumber,v1=abc')).toBeNull();
  });

  it('rejects undefined input', () => {
    expect(parseSignatureHeader(undefined)).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parseSignatureHeader('')).toBeNull();
  });
});

describe('verifySignature', () => {
  const body = Buffer.from('{"event_id":"evt_1","event_type":"x"}');

  it('accepts a valid signature', () => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = sign(body, t);
    const result = verifySignature(body, `t=${t},v1=${v1}`, SECRET);
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = sign(body, t);
    const tampered = Buffer.from('{"event_id":"evt_1","event_type":"y"}');
    const result = verifySignature(tampered, `t=${t},v1=${v1}`, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('rejected_signature');
  });

  it('rejects a wrong secret', () => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = sign(body, t, 'wrong_secret');
    const result = verifySignature(body, `t=${t},v1=${v1}`, SECRET);
    expect(result.valid).toBe(false);
  });

  it('rejects a timestamp older than 300s', () => {
    const now = Math.floor(Date.now() / 1000);
    const t = now - 400;
    const v1 = sign(body, t);
    const result = verifySignature(body, `t=${t},v1=${v1}`, SECRET, now);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('rejected_signature');
  });

  it('rejects a far-future timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const t = now + 400;
    const v1 = sign(body, t);
    const result = verifySignature(body, `t=${t},v1=${v1}`, SECRET, now);
    expect(result.valid).toBe(false);
  });

  it('rejects a missing header', () => {
    const result = verifySignature(body, undefined, SECRET);
    expect(result.valid).toBe(false);
  });

  it('uses raw bytes — verifying re-serialized JSON would fail', () => {
    // Reproduce the bug where someone forgets to keep the raw Buffer and
    // re-JSON-stringifies the parsed body. The signed bytes diverge,
    // verification must fail.
    const t = Math.floor(Date.now() / 1000);
    const v1 = sign(body, t);
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(body.toString())) + ' ',
    );
    const result = verifySignature(reserialized, `t=${t},v1=${v1}`, SECRET);
    expect(result.valid).toBe(false);
  });
});

describe('generators', () => {
  it('generateSigningSecret returns 64-char hex (32 bytes)', () => {
    const s = generateSigningSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generateSigningSecret yields high entropy', () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).not.toEqual(b);
  });

  it('generateUrlToken returns url-safe base64', () => {
    const t = generateUrlToken();
    // base64url, no padding, ~43 chars for 32 bytes
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it('generateUrlToken yields high entropy', () => {
    expect(generateUrlToken()).not.toEqual(generateUrlToken());
  });

  it('secretHint returns last 4 chars only', () => {
    expect(secretHint('0123456789abcdef')).toBe('cdef');
    expect(secretHint('xx')).toBe('xx');
  });
});
