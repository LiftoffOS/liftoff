// A redaction that removes the finding along with the secret.
//
// The reviewer reads a diff THROUGH this filter — `pull_request_read
// { method: get_diff }` returns a unified diff as text and every string of it
// is scrubbed. With a bare `[REDACTED]` the agent sees a line it cannot
// characterise, so the review says nothing and the secret ships. Telling you a
// commit adds a credential is among the most valuable things it does, and the
// guardrail meant to protect you was what silenced it.

import { BUILTIN_OUTPUT_GUARDRAILS } from '../output-guardrails';

const scrub = async (data: unknown): Promise<any> => {
  let out = data;
  for (const g of BUILTIN_OUTPUT_GUARDRAILS) out = await g.check('get_diff', {}, out, 't1');
  return out;
};

describe('redaction names what it removed', () => {
  it('keeps a diff reviewable while removing the value', async () => {
    const diff = [
      'diff --git a/config.ts b/config.ts',
      '+++ b/config.ts',
      '+const key = "AKIA1234567890ABCDEF";',
    ].join('\n');

    const out: string = await scrub(diff);
    // The value is gone.
    expect(out).not.toContain('AKIA1234567890ABCDEF');
    // The finding survives: the reviewer can still say WHAT was added, and where.
    expect(out).toContain('[REDACTED:aws-access-key-id]');
    expect(out).toContain('b/config.ts');
    expect(out).toContain('const key =');
  });

  it('names each kind it knows, and never leaks part of the match into the label', async () => {
    const cases: Array<[string, string]> = [
      ['ghp_' + 'a'.repeat(36), 'github-token'],
      ['xoxb-1-2-abcdef', 'slack-token'],
      ['sk-' + 'b'.repeat(32), 'openai-api-key'],
      ['-----BEGIN RSA PRIVATE KEY-----', 'private-key-block'],
    ];
    for (const [secret, kind] of cases) {
      const out: string = await scrub(`value: ${secret} end`);
      expect(out).toContain(`[REDACTED:${kind}]`);
      expect(out).not.toContain(secret);
      // The label is a fixed word from the table, so no part of the secret can
      // ride out inside the marker.
      expect(out).toMatch(/\[REDACTED:[a-z-]+\]/);
    }
  });

  it('still walks nested structures, not just top-level strings', async () => {
    const out = await scrub({ files: [{ patch: 'token=ghp_' + 'c'.repeat(36) }] });
    expect(JSON.stringify(out)).toContain('[REDACTED:github-token]');
  });

  it('leaves ordinary content untouched', async () => {
    const text = 'the review found two suggestions and no blocking issues';
    expect(await scrub(text)).toBe(text);
  });
});
