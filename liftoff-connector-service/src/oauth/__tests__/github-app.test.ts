// Acting on GitHub as Liftoff rather than as a person.
//
// An agent that selects "the oldest PR carrying no review FROM THIS AGENT on
// its current head sha" cannot answer that while the platform writes with a
// borrowed user token — its own reviews look like a person's, so it keeps
// picking the same pull request. This module replaces that token.
//
// The most important property here is the LAST one: with the App unconfigured
// every function returns null so the caller falls back to the stored OAuth
// token. That is what lets this ship without a flag and without a cutover.

import crypto from 'node:crypto';
import {
  mintAppJwt,
  githubAppCredentials,
  isGithubAppConfigured,
  getInstallationToken,
  buildInstallUrl,
  __clearInstallationTokenCache,
} from '../github-app.js';

jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

function configureApp(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  process.env.GITHUB_APP_ID = overrides.GITHUB_APP_ID ?? '123456';
  process.env.GITHUB_APP_SLUG = overrides.GITHUB_APP_SLUG ?? 'dev';
  process.env.GITHUB_APP_PRIVATE_KEY = overrides.GITHUB_APP_PRIVATE_KEY ?? privateKey;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  __clearInstallationTokenCache();
  jest.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

describe('mintAppJwt', () => {
  it('produces a signature GitHub can actually verify', () => {
    configureApp();
    const jwt = mintAppJwt(githubAppCredentials()!, 1_756_000_000_000);
    const [header, payload, signature] = jwt.split('.');

    const verified = crypto
      .createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));

    expect(verified).toBe(true);
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('backdates iat, because GitHub rejects a JWT from its own future', () => {
    // Container clocks drift; this is GitHub's own recommendation.
    configureApp();
    const nowMs = 1_756_000_000_000;
    const claims = decodeSegment(mintAppJwt(githubAppCredentials()!, nowMs).split('.')[1]);
    expect(claims.iat).toBe(Math.floor(nowMs / 1000) - 60);
  });

  it('expires inside the ten minutes GitHub allows', () => {
    configureApp();
    const nowMs = 1_756_000_000_000;
    const claims = decodeSegment(mintAppJwt(githubAppCredentials()!, nowMs).split('.')[1]);
    expect((claims.exp as number) - Math.floor(nowMs / 1000)).toBeLessThan(600);
    expect(claims.iss).toBe('123456');
  });
});

describe('githubAppCredentials', () => {
  it('restores newlines in a PEM stored with escapes', () => {
    // Cloud Run env vars cannot hold literal newlines. A key that keeps its
    // escapes signs nothing and fails with an opaque OpenSSL error at the first
    // real call, which is a miserable thing to debug in prod.
    configureApp({ GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') });
    const creds = githubAppCredentials();
    expect(creds?.privateKeyPem).toBe(privateKey);
    // And it still signs.
    expect(() => mintAppJwt(creds!)).not.toThrow();
  });

  it('is null unless every part is present', () => {
    configureApp();
    delete process.env.GITHUB_APP_SLUG;
    expect(githubAppCredentials()).toBeNull();
    expect(isGithubAppConfigured()).toBe(false);
  });
});

describe('getInstallationToken', () => {
  it('mints, then serves the cached token without a second call', async () => {
    configureApp();
    const fetchMock = jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'ghs_abc', expires_at: new Date(2_000_000_000_000).toISOString() }),
    } as never);

    const first = await getInstallationToken(42, 1_000_000_000_000);
    const second = await getInstallationToken(42, 1_000_000_000_000);

    expect(first).toBe('ghs_abc');
    expect(second).toBe('ghs_abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints when the cached token is inside the refresh margin', async () => {
    // A dispatch that starts on a token expiring mid-call surfaces as a 401 the
    // agent can do nothing about.
    configureApp();
    const expiresAtMs = 1_000_000_300_000; // five minutes after "now"
    const fetchMock = jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'ghs_abc', expires_at: new Date(expiresAtMs).toISOString() }),
    } as never);

    await getInstallationToken(42, 1_000_000_000_000);
    await getInstallationToken(42, 1_000_000_001_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keys the cache per installation, so one org cannot serve another', async () => {
    configureApp();
    let n = 0;
    jest.spyOn(global, 'fetch' as never).mockImplementation((async () => ({
      ok: true,
      json: async () => ({ token: `ghs_${++n}`, expires_at: new Date(2_000_000_000_000).toISOString() }),
    })) as never);

    expect(await getInstallationToken(1, 1_000_000_000_000)).toBe('ghs_1');
    expect(await getInstallationToken(2, 1_000_000_000_000)).toBe('ghs_2');
    expect(await getInstallationToken(1, 1_000_000_000_000)).toBe('ghs_1');
  });

  it('surfaces a mint failure rather than returning a token-shaped nothing', async () => {
    configureApp();
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      json: async () => ({}),
    } as never);

    await expect(getInstallationToken(42)).rejects.toThrow(/404/);
  });
});

describe('buildInstallUrl', () => {
  it('omits repository_ids so All repositories stays the default', () => {
    // GitHub's rule: "If omitted, all repositories are selected." Under All, a
    // repository created next month is covered automatically. Under a fixed
    // selection it is invisible until a human adds it, and nothing says so.
    const url = buildInstallUrl({ slug: 'dev', state: 'gha_x', suggestedTargetId: 99 });
    expect(url).not.toContain('repository_ids');
    expect(url).toContain('https://github.com/apps/dev/installations/new/permissions');
    expect(url).toContain('suggested_target_id=99');
    expect(url).toContain('state=gha_x');
  });

  it('works with no suggestion at all', () => {
    const url = buildInstallUrl({ slug: 'dev', state: 'gha_x' });
    expect(url).not.toContain('suggested_target_id');
  });
});

describe('with the App unconfigured', () => {
  // The property that lets this ship without a flag: every entry point
  // returns null, and the credential path falls back to the stored OAuth user
  // token. A connector row with no installation behaves exactly as it does now.
  it('returns null rather than throwing, so callers fall back', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const fetchMock = jest.spyOn(global, 'fetch' as never);

    expect(isGithubAppConfigured()).toBe(false);
    expect(githubAppCredentials()).toBeNull();
    await expect(getInstallationToken(42)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
