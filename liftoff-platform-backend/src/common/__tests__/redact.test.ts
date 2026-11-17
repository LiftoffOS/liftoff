// E4 — credential redaction on egress.
//
// These assert the contract: a credential-shaped token never survives into text
// we store or send to a model, and ordinary prose is left alone (a redactor
// that mangles normal sentences would quietly degrade every summary).

import { redactSensitiveText, redactMessagesForEgress } from '../redact';

describe('redactSensitiveText', () => {
  it.each([
    ['Anthropic key', 'sk-ant-api03-' + 'a'.repeat(64)],
    ['GitHub PAT', 'ghp_' + 'a'.repeat(36)],
    ['GitHub app token', 'ghs_' + 'b'.repeat(36)],
    ['Google API key', 'AIza' + 'a'.repeat(35)],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['Stripe live key', 'sk_live_' + 'c'.repeat(30)],
    ['Slack bot token', 'xoxb-123456789-987654321-' + 'd'.repeat(30)],
    ['npm token', 'npm_' + 'e'.repeat(36)],
    ['GitLab PAT', 'glpat-' + 'f'.repeat(20)],
    ['HuggingFace token', 'hf_' + 'g'.repeat(34)],
  ])('removes a %s', (_label, secret) => {
    const out = redactSensitiveText(`here is the key ${secret} use it`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('removes a JWT', () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(30)}.${'c'.repeat(30)}`;
    expect(redactSensitiveText(jwt)).not.toContain(jwt);
  });

  it('removes a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----';
    const out = redactSensitiveText(`config:\n${pem}\ndone`);
    expect(out).not.toContain('MIIEpAIBAAKC');
    expect(out).toContain('done');
  });

  it('keeps the shape of a connection string but drops the password', () => {
    const out = redactSensitiveText('postgres://reporting_user:hunter2SuperSecret@db.internal:5432/analytics');
    expect(out).not.toContain('hunter2SuperSecret');
    expect(out).toContain('postgres://reporting_user:[REDACTED]@');
    // The host is retained on purpose: a redacted summary should still be able
    // to say WHICH database was involved.
    expect(out).toContain('db.internal:5432/analytics');
  });

  it('drops credentials embedded in an http URL', () => {
    const out = redactSensitiveText('curl https://admin:p4ssw0rd-value@example.com/api');
    expect(out).not.toContain('p4ssw0rd-value');
    expect(out).toContain('https://admin:[REDACTED]@');
  });

  it('drops a bearer token but keeps the header name', () => {
    const out = redactSensitiveText('Authorization: Bearer abcdef1234567890abcdef');
    expect(out).not.toContain('abcdef1234567890abcdef');
    expect(out).toContain('Authorization: Bearer [REDACTED]');
  });

  it.each([
    'api_key = "abcdefghijklmnop1234"',
    "password: 'correct-horse-battery'",
    'CLIENT_SECRET=zyxwvutsrq0987654321',
    'access_token: aaaaaaaaaaaaaaaaaaaaaa',
  ])('drops an assigned secret (%s)', (line) => {
    const out = redactSensitiveText(line);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/abcdefghijklmnop1234|correct-horse-battery|zyxwvutsrq0987654321|aaaaaaaaaaaaaaaaaaaaaa/);
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Please summarise the Q3 pipeline and flag any deal without a next step.';
    expect(redactSensitiveText(prose)).toBe(prose);
  });

  it('leaves a plain URL untouched', () => {
    const text = 'The dashboard is at https://app.example.com/reports/42 and updates hourly.';
    expect(redactSensitiveText(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(redactSensitiveText('')).toBe('');
  });

  it('is repeatable — redacting twice changes nothing further', () => {
    const once = redactSensitiveText('key ghp_' + 'a'.repeat(36));
    expect(redactSensitiveText(once)).toBe(once);
  });

  it('redacts every occurrence, not just the first', () => {
    const a = 'ghp_' + 'a'.repeat(36);
    const b = 'ghp_' + 'b'.repeat(36);
    const out = redactSensitiveText(`first ${a} second ${b}`);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
  });
});

describe('redactMessagesForEgress', () => {
  it('redacts content while preserving the other message fields', () => {
    const messages = [
      { role: 'user', content: 'token ghp_' + 'a'.repeat(36) },
      { role: 'assistant', content: 'Understood.' },
    ];
    const out = redactMessagesForEgress(messages);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toContain('[REDACTED]');
    expect(out[1].content).toBe('Understood.');
  });
});
