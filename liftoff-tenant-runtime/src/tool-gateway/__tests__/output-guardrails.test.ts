import { BUILTIN_OUTPUT_GUARDRAILS, GuardrailBlockError } from '../output-guardrails';

// By NAME, not by position: this file's every assertion is about secret-scrub,
// and indexing meant adding a guardrail ahead of it pointed them all at a
// different one, which reads as the scrub having stopped working.
const guardrail = BUILTIN_OUTPUT_GUARDRAILS.find((g) => g.name === 'secret-scrub')!;

async function scrub(output: unknown): Promise<unknown> {
  return guardrail.check('any_tool', {}, output, 'tenant-test');
}

describe('secretScrubGuardrail', () => {
  describe('Anthropic-style sk- API keys', () => {
    it('redacts sk- key with 32+ chars', async () => {
      const out = await scrub('key is sk-abcdefghijklmnopqrstuvwxyz12345678');
      expect(out).toBe('key is [REDACTED:openai-api-key]');
    });

    it('passes through sk- key with fewer than 32 chars', async () => {
      const out = await scrub('not-a-key sk-short');
      expect(out).toBe('not-a-key sk-short');
    });
  });

  describe('Bearer tokens', () => {
    it('redacts Bearer token with 20+ chars', async () => {
      const out = await scrub('Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig');
      expect(out).toContain('[REDACTED:');
      expect(out).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    });
  });

  describe('Generic api_key / access_token patterns', () => {
    it('redacts api_key = "..." pattern', async () => {
      const out = await scrub('api_key = "abcdefghijklmnopqrstuvwxyz123456"');
      expect(out).toContain('[REDACTED:');
    });

    it('redacts access_token: value pattern', async () => {
      const out = await scrub('access_token: ghp_abcdefghijklmnopqrstuvwxyz123456');
      expect(out).toContain('[REDACTED:');
    });
  });

  describe('Password patterns', () => {
    it('redacts password = "..." pattern', async () => {
      const out = await scrub('password="supersecret"');
      expect(out).toContain('[REDACTED:');
    });

    it('does not redact short password values (under 8 chars)', async () => {
      const out = await scrub('password="short"');
      // pattern requires 8+ chars inside quotes
      expect(out).toBe('password="short"');
    });
  });

  describe('PEM private keys', () => {
    it('redacts BEGIN RSA PRIVATE KEY header', async () => {
      const out = await scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----');
      expect(out).toContain('[REDACTED:');
    });

    it('redacts BEGIN OPENSSH PRIVATE KEY header', async () => {
      const out = await scrub('-----BEGIN OPENSSH PRIVATE KEY-----\nkey data\n-----END');
      expect(out).toContain('[REDACTED:');
    });
  });

  describe('GitHub PATs', () => {
    it('redacts ghp_ token', async () => {
      const out = await scrub('token: ghp_abcdefghijklmnopqrstuvwxyz1234567890');
      expect(out).toContain('[REDACTED:');
    });

    it('redacts gho_ token', async () => {
      const out = await scrub('gho_abcdefghijklmnopqrstuvwxyz123456789012');
      expect(out).toContain('[REDACTED:');
    });
  });

  describe('Slack tokens', () => {
    it('redacts xoxb- bot token', async () => {
      // Short value avoids secret-scanning heuristics while still matching the regex
      const out = await scrub('xoxb-fake-bot-token-for-testing');
      expect(out).toContain('[REDACTED:');
    });

    it('redacts xoxp- user token', async () => {
      const out = await scrub('xoxp-fake-user-token-for-testing');
      expect(out).toContain('[REDACTED:');
    });
  });

  describe('AWS access key IDs', () => {
    it('redacts AKIA key', async () => {
      const out = await scrub('AWS Key: AKIAIOSFODNN7EXAMPLE');
      expect(out).toContain('[REDACTED:');
    });
  });

  describe('Nested structures', () => {
    it('scrubs secrets inside object values', async () => {
      const out = await scrub({
        status: 'ok',
        credentials: { key: 'sk-abcdefghijklmnopqrstuvwxyz12345678' },
      }) as Record<string, unknown>;
      const creds = out.credentials as Record<string, unknown>;
      expect(creds.key).toBe('[REDACTED:openai-api-key]');
      expect(out.status).toBe('ok');
    });

    it('scrubs secrets inside array elements', async () => {
      const out = await scrub(['normal text', 'sk-abcdefghijklmnopqrstuvwxyz12345678']) as string[];
      expect(out[0]).toBe('normal text');
      expect(out[1]).toBe('[REDACTED:openai-api-key]');
    });

    it('scrubs deeply nested secret', async () => {
      const out = await scrub({
        data: { nested: { token: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' } },
      }) as Record<string, unknown>;
      const token = ((out.data as Record<string, unknown>).nested as Record<string, unknown>).token as string;
      expect(token).toContain('[REDACTED:');
    });
  });

  describe('Safe content', () => {
    it('passes through plain text unchanged', async () => {
      const out = await scrub('This is a normal API response with no secrets.');
      expect(out).toBe('This is a normal API response with no secrets.');
    });

    it('passes through numbers unchanged', async () => {
      const out = await scrub(42);
      expect(out).toBe(42);
    });

    it('passes through null unchanged', async () => {
      const out = await scrub(null);
      expect(out).toBeNull();
    });

    it('passes through booleans unchanged', async () => {
      expect(await scrub(true)).toBe(true);
      expect(await scrub(false)).toBe(false);
    });
  });
});

describe('GuardrailBlockError', () => {
  it('has name GuardrailBlockError', () => {
    const err = new GuardrailBlockError('blocked');
    expect(err.name).toBe('GuardrailBlockError');
    expect(err.message).toBe('blocked');
    expect(err instanceof Error).toBe(true);
  });
});

describe('BUILTIN_OUTPUT_GUARDRAILS', () => {
  it('contains the built-ins, in order', () => {
    // Order matters and is asserted, not incidental — and it is deliberately
    // the order that makes egress-only's secret-shaped branch REDUNDANT.
    //
    // Guardrails run in array order, each seeing the previous one's output, so
    // secret-scrub has already replaced a secret-shaped value with
    // [REDACTED:kind] by the time egress-only looks at it. Putting egress-only
    // first would let it lift the REAL secret onto the side channel, and step
    // (a) is explicitly about values no user ever needed to see. Sending one to
    // the surface to avoid sending it to the model is not a trade worth making.
    //
    // So egress-only's contribution at step (a) is the SENSITIVE-CATEGORISED
    // path: a field a connector declared egressOnly on a tool categorised
    // sensitive, whatever the value happens to look like.
    //
    // staged-write runs LAST: it records what a stage prepared and hands the
    // model the batch id, and it must see the result the model will see —
    // scrubbed and lifted — not the vendor's raw answer.
    //
    // document-text runs FIRST, and that is the only position it can hold for
    // the same class of reason the others have one. It drops a document read's
    // typography — list glyphs, indent magnitudes, named styles — which is both
    // most of the payload and none of the content. Running it first means every
    // guardrail below walks the text rather than 13 KB of style definitions,
    // and a credential sitting in a dropped style block is gone rather than
    // redacted. Running it last would have each of them read the whole tree to
    // no purpose.
    expect(BUILTIN_OUTPUT_GUARDRAILS.map((g) => g.name))
      .toEqual(['document-text', 'secret-scrub', 'egress-only', 'staged-write']);
  });

  it('keeps secret-scrub ahead of egress-only, which is the ordering that matters', () => {
    // Stated as its own property rather than left implicit in the list above,
    // because it is the one pair whose order is a security claim: egress-only
    // first would lift the REAL secret onto the side channel.
    const names = BUILTIN_OUTPUT_GUARDRAILS.map((g) => g.name);
    expect(names.indexOf('secret-scrub')).toBeLessThan(names.indexOf('egress-only'));
  });

  it('runs the projection before the scrub, so the scrub reads text not styles', () => {
    const names = BUILTIN_OUTPUT_GUARDRAILS.map((g) => g.name);
    expect(names.indexOf('document-text')).toBeLessThan(names.indexOf('secret-scrub'));
  });
});
