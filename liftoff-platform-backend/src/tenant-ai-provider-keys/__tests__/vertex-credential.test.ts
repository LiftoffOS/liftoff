// Google's credential is not a key, and this is where that stops being a
// surprise.
//
// Three of the four vendors issue an opaque bearer string. A customer's Google
// AI capacity lives in their own Vertex project, and the credential for it is a
// service account: a project, a location and a key pair. It is never sent as a
// credential — it is EXCHANGED for a short-lived access token — which is why the
// stored shape is a union rather than a string, and why access stays perpetual
// even though every token expires within the hour.

import {
  DEFAULT_VERTEX_LOCATION,
  parseSubmittedCredential,
  type VertexServiceAccountCredential,
} from '../types';

/** A private key shaped like the real thing. Not a usable key — nothing here
 *  signs with it — but PEM-framed, which is what the parser checks. */
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----\n';

/** What Google actually hands a customer: the downloaded JSON key file. */
const SERVICE_ACCOUNT_FILE = JSON.stringify({
  type: 'service_account',
  project_id: 'customer-prod-1234',
  private_key_id: 'abc123',
  private_key: PEM,
  client_email: 'platform-backend@example-project.iam.gserviceaccount.com',
  client_id: '1234567890',
});

function expectOk(raw: string): VertexServiceAccountCredential {
  const result = parseSubmittedCredential('google', raw);
  if (!result.ok) throw new Error(`expected a credential, got: ${result.message}`);
  if (result.credential.kind !== 'vertex_service_account') {
    throw new Error('expected a vertex service account');
  }
  return result.credential;
}

describe('the downloaded service-account file', () => {
  it('is accepted as-is, because it is what the customer has in hand', () => {
    // Demanding a hand-assembled object would be an obstacle with no purpose:
    // the file already carries the project, the address and the key.
    const credential = expectOk(SERVICE_ACCOUNT_FILE);
    expect(credential.project).toBe('customer-prod-1234');
    expect(credential.clientEmail)
      .toBe('platform-backend@example-project.iam.gserviceaccount.com');
    expect(credential.privateKey).toBe(PEM);
  });

  it('defaults the location the file does not carry', () => {
    // `global` is Vertex's meta-endpoint: it routes to wherever the requested
    // model is served, and it is the only location that serves every current
    // Gemini model here. Regional endpoints 404 for several of them.
    expect(expectOk(SERVICE_ACCOUNT_FILE).location).toBe(DEFAULT_VERTEX_LOCATION);
    expect(DEFAULT_VERTEX_LOCATION).toBe('global');
  });

  it('restores escaped newlines in the key', () => {
    // A PEM that has been through a copy-paste comes back with literal \\n. The
    // failure it causes otherwise is an OpenSSL parse error nobody can act on.
    const escaped = JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      client_email: 'platform-backend@example-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADAN\\n-----END PRIVATE KEY-----\\n',
    });
    expect(expectOk(escaped).privateKey).toContain('\n');
    expect(expectOk(escaped).privateKey).not.toContain('\\n');
  });
});

describe('the explicit object form', () => {
  it('is accepted, and is the only way to name a location', () => {
    const credential = expectOk(JSON.stringify({
      project: 'customer-eu-9',
      location: 'europe-west4',
      googleCredentials: {
        privateKey: PEM,
        clientEmail: 'platform-backend@example-project.iam.gserviceaccount.com',
      },
    }));
    expect(credential).toEqual({
      kind: 'vertex_service_account',
      project: 'customer-eu-9',
      location: 'europe-west4',
      clientEmail: 'platform-backend@example-project.iam.gserviceaccount.com',
      privateKey: PEM,
    });
  });
});

describe('what is refused, and why it is refused here', () => {
  // Every rejection below is certain without a network call, and each one would
  // otherwise surface as an opaque failure much later: a 401 on the customer's
  // first turn, or an OpenSSL error in a log nobody reads.

  it('an API key pasted into the Google field', () => {
    const result = parseSubmittedCredential('google', 'AIza-REDACTED');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The message has to say what to paste instead, or the customer retries the
    // same thing.
    expect(result.message).toMatch(/service account/i);
    expect(result.message).toMatch(/JSON key file/i);
  });

  it('a service account missing any of the three fields it needs', () => {
    for (const [field, file] of [
      ['project', { client_email: 'a@b.com', private_key: PEM }],
      ['client email', { project_id: 'p', private_key: PEM }],
      ['private key', { project_id: 'p', client_email: 'a@b.com' }],
    ] as const) {
      const result = parseSubmittedCredential('google', JSON.stringify(file));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.message).toContain(field);
    }
  });

  it('a private key that is not PEM', () => {
    const result = parseSubmittedCredential('google', JSON.stringify({
      project_id: 'p',
      client_email: 'a@b.com',
      private_key: 'ya29.a0AfB_not-a-pem-block',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/PEM/);
  });

  it('our own hint pasted back', () => {
    const result = parseSubmittedCredential('anthropic', 'sk-ant••••••••3f2x');
    expect(result.ok).toBe(false);
  });
});

describe('the hint a service account reads back as', () => {
  it('is the service account address, not a redaction of the key', () => {
    // The hint's job is to say WHICH credential is stored. For a key that is a
    // head and a tail; for a service account it is the address, which does the
    // same job and discloses nothing — it is visible on the customer's own IAM
    // page, and the secret half is the private key, which never leaves here.
    const result = parseSubmittedCredential('google', SERVICE_ACCOUNT_FILE);
    if (!result.ok) throw new Error('unreachable');
    expect(result.hint).toBe('platform-backend@example-project.iam.gserviceaccount.com');
    expect(result.hint).not.toContain('PRIVATE KEY');
  });

  it('never carries any part of the private key', () => {
    const result = parseSubmittedCredential('google', SERVICE_ACCOUNT_FILE);
    if (!result.ok) throw new Error('unreachable');
    expect(result.hint).not.toContain('MIIEvQIBADAN');
  });
});

describe('the other three vendors are unchanged', () => {
  it.each(['anthropic', 'openai', 'xai'] as const)('%s still takes an opaque key', (vendor) => {
    const result = parseSubmittedCredential(vendor, 'sk-ant-api03-not-a-real-key-3f2x');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.credential).toEqual({
      kind: 'api_key',
      apiKey: 'sk-ant-api03-not-a-real-key-3f2x',
    });
    expect(result.hint).toBe('sk-ant••••••••3f2x');
  });
});
