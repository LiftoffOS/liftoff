// Tests for src/security/log-redactor.ts (Phase 4I)

import { redactSecrets, redactString } from '../log-redactor';

describe('redactString', () => {
  it('redacts Bearer tokens in strings', () => {
    const raw = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123def456ghi';
    const out = redactString(raw);
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('redacts sk- API keys in strings', () => {
    const raw = 'Using API key sk-abcdefghij1234567890 for request';
    const out = redactString(raw);
    expect(out).not.toContain('sk-abcdefghij1234567890');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts AWS-style access key IDs', () => {
    const raw = 'AWS key AKIAIOSFODNN7EXAMPLE is invalid';
    const out = redactString(raw);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts GCP private key PEM block', () => {
    const raw = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const out = redactString(raw);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves non-sensitive strings untouched', () => {
    const raw = 'Processing task for agent agent-abc-123 in tenant tenant-xyz';
    const out = redactString(raw);
    expect(out).toBe(raw);
  });

  it('handles empty string', () => {
    expect(redactString('')).toBe('');
  });
});

describe('redactSecrets — key-name redaction', () => {
  it('redacts access_token key', () => {
    const obj = { access_token: 'ya29.abcdefghijk', tenant_id: 'tenant-a' };
    const out = redactSecrets(obj) as any;
    expect(out.access_token).toBe('[REDACTED]');
    expect(out.tenant_id).toBe('tenant-a');
  });

  it('redacts refresh_token key', () => {
    const obj = { refresh_token: '1//0eXYZ' };
    const out = redactSecrets(obj) as any;
    expect(out.refresh_token).toBe('[REDACTED]');
  });

  it('redacts client_secret key', () => {
    const obj = { client_secret: 'supersecret', client_id: 'id-123' };
    const out = redactSecrets(obj) as any;
    expect(out.client_secret).toBe('[REDACTED]');
    expect(out.client_id).toBe('id-123');
  });

  it('redacts api_key key', () => {
    const obj = { api_key: 'sk-proj-abcdef', model: 'gpt-4' };
    const out = redactSecrets(obj) as any;
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.model).toBe('gpt-4');
  });

  it('redacts private_key nested in GCP service account object', () => {
    const obj = {
      type: 'service_account',
      project_id: 'my-project',
      private_key_id: 'abc123',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----\n',
      client_email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com',
    };
    const out = redactSecrets(obj) as any;
    expect(out.private_key).toBe('[REDACTED]');
    expect(out.private_key_id).toBe('[REDACTED]');
    expect(out.project_id).toBe('my-project');
    expect(out.client_email).toBe('YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com');
    expect(out.type).toBe('service_account');
  });

  it('redacts nested client_secret in deeply-nested object', () => {
    const obj = {
      level1: {
        level2: {
          client_secret: 'deep-secret',
          safe_field: 'visible',
        },
      },
    };
    const out = redactSecrets(obj) as any;
    expect(out.level1.level2.client_secret).toBe('[REDACTED]');
    expect(out.level1.level2.safe_field).toBe('visible');
  });

  it('does not modify the original object', () => {
    const original = { access_token: 'token-abc', name: 'test' };
    redactSecrets(original);
    expect(original.access_token).toBe('token-abc');
  });

  it('leaves non-sensitive fields untouched', () => {
    const obj = {
      tenant_id: 'tenant-a',
      agent_id: 'agent-b',
      level: 'info',
      message: 'Processing connector',
      duration_ms: 42,
    };
    const out = redactSecrets(obj) as any;
    expect(out.tenant_id).toBe('tenant-a');
    expect(out.agent_id).toBe('agent-b');
    expect(out.level).toBe('info');
    expect(out.message).toBe('Processing connector');
    expect(out.duration_ms).toBe(42);
  });
});

describe('redactSecrets — value-pattern redaction in strings', () => {
  it('redacts Bearer token appearing as string value in object', () => {
    const obj = { authorization: 'Bearer ya29.lmno', path: '/api/test' };
    const out = redactSecrets(obj) as any;
    // authorization is a sensitive key → value is always redacted
    expect(out.authorization).toBe('[REDACTED]');
  });

  it('redacts Bearer token in a non-sensitive string field', () => {
    const obj = { debug_raw_header: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' };
    const out = redactSecrets(obj) as any;
    expect(out.debug_raw_header).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out.debug_raw_header).toContain('Bearer [REDACTED]');
  });
});

describe('redactSecrets — edge cases', () => {
  it('handles null input', () => {
    expect(redactSecrets(null)).toBeNull();
  });

  it('handles undefined input', () => {
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it('handles array containing sensitive objects', () => {
    const arr = [
      { access_token: 'tok1', id: 1 },
      { tenant_id: 'tenant-a', id: 2 },
    ];
    const out = redactSecrets(arr) as any[];
    expect(out[0].access_token).toBe('[REDACTED]');
    expect(out[0].id).toBe(1);
    expect(out[1].tenant_id).toBe('tenant-a');
    expect(out[1].id).toBe(2);
  });

  it('handles boolean and number values unchanged', () => {
    const obj = { enabled: true, count: 42 };
    const out = redactSecrets(obj) as any;
    expect(out.enabled).toBe(true);
    expect(out.count).toBe(42);
  });

  it('handles Date values', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    const obj = { created_at: d };
    const out = redactSecrets(obj) as any;
    expect(out.created_at).toBeInstanceOf(Date);
    expect((out.created_at as Date).getTime()).toBe(d.getTime());
  });

  it('handles empty object', () => {
    expect(redactSecrets({})).toEqual({});
  });

  it('handles empty array', () => {
    expect(redactSecrets([])).toEqual([]);
  });
});
