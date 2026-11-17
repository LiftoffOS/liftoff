// Acting on GitHub as Liftoff, rather than as whoever clicked connect.
//
// WHY THIS EXISTS
// ───────────────
// The GitHub connector holds a user-to-server OAuth token, so every write the
// platform makes appears authored by a person. An agent told to "select the
// oldest PR carrying no review FROM THIS AGENT on its current head sha" cannot
// answer that in principle while its own review is indistinguishable from a
// human's, so it keeps re-selecting the same pull request.
//
// Slack has the same rule: the platform posts as the Liftoff app, never as a
// person. This is the same answer
// for GitHub. A GitHub App has its own identity (`Liftoff[bot]`), and an
// INSTALLATION ACCESS TOKEN makes API writes appear as the app.
//
// DEGRADES TO THE USER TOKEN. Everything here returns null when the App is not
// configured, and the credential path falls back to the stored OAuth token. A
// connector row with no installation behaves exactly as it does today. That is
// what lets this ship without a flag and without a cutover.
//
// THE PRIVATE KEY IS PLATFORM-WIDE, NOT PER-TENANT. secrets/client.ts keys on
// `connector-{tenantId}-{connectorId}` because it holds one tenant's
// credentials. The App key is one key for the whole estate, so it arrives as an
// env var mounted from Secret Manager, the same shape as GITHUB_CLIENT_SECRET.

import crypto from 'node:crypto';
import { logger } from '../infra/logging.js';

export interface GithubAppCredentials {
  appId: string;
  /** The slug from the app's public page URL — `github.com/apps/<slug>`. Used
   *  to build the installation URL, which takes the slug and not the id. */
  slug: string;
  privateKeyPem: string;
}

/** Installation tokens live one hour. Refreshing with five minutes left keeps a
 *  long-running dispatch from starting on a token that expires mid-call, which
 *  surfaces as a 401 the agent cannot do anything about. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The app JWT is only ever exchanged for an installation token, immediately.
 *  GitHub rejects anything over ten minutes; nine leaves room for clock skew in
 *  the other direction. */
const APP_JWT_TTL_SECONDS = 9 * 60;

/** GitHub rejects a JWT whose `iat` is in its future, and container clocks
 *  drift. Backdating by a minute is what GitHub's own documentation recommends. */
const APP_JWT_BACKDATE_SECONDS = 60;

const GITHUB_API = 'https://api.github.com';

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Keyed by installation id. Process-local on purpose: a token is cheap to mint
 *  and sharing them across instances would mean putting a live credential in a
 *  cache other things can read. */
const tokenCache = new Map<number, CachedToken>();

/** Visible for testing. */
export function __clearInstallationTokenCache(): void {
  tokenCache.clear();
}

/**
 * The App's credentials, or null when it is not configured.
 *
 * Null is a supported state, not an error: until the App is registered and its
 * key is mounted, every caller here falls back to the OAuth user token and the
 * product behaves exactly as it did before.
 */
export function githubAppCredentials(): GithubAppCredentials | null {
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG;
  // Cloud Run env vars cannot hold literal newlines, so the PEM is stored with
  // `\n` escapes and restored here. A key that still has the escapes signs
  // nothing and fails with an opaque OpenSSL error, which is a miserable thing
  // to debug at the first real call.
  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !slug || !privateKeyPem) return null;
  // A value that is present but is not a key means the App is not really
  // configured — a deployment can carry placeholder secret versions so its
  // deploys do not fail on a missing secret before its own App exists. Treating a placeholder
  // as configured would mint a JWT with a bogus key and fail at the first real
  // call with an opaque OpenSSL error, instead of falling back to the user token.
  if (!privateKeyPem.includes('PRIVATE KEY')) return null;
  return { appId, slug, privateKeyPem };
}

export function isGithubAppConfigured(): boolean {
  return githubAppCredentials() !== null;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sign the short-lived JWT that authenticates as the App itself.
 *
 * Hand-rolled rather than pulled from a JWT library: it is a header, a payload
 * and one RS256 signature, and this repo shares one `node_modules` across many
 * worktrees — a new dependency there is a bigger liability than fifteen lines.
 */
export function mintAppJwt(creds: GithubAppCredentials, nowMs: number = Date.now()): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
      exp: nowSeconds + APP_JWT_TTL_SECONDS,
      iss: creds.appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(creds.privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

async function githubRequest<T>(
  path: string,
  init: { method: 'GET' | 'POST'; token: string },
): Promise<T> {
  const resp = await fetch(`${GITHUB_API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${init.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'liftoff-connector-service',
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`github ${init.method} ${path} failed: ${resp.status} ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

/**
 * A token that acts as the App on one installation. This is the credential that
 * makes a write show up as `Liftoff[bot]`.
 *
 * Returns null when the App is not configured, so the caller falls back rather
 * than failing — see the header.
 */
export async function getInstallationToken(
  installationId: number,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const creds = githubAppCredentials();
  if (!creds) return null;

  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs) {
    return cached.token;
  }

  const jwt = mintAppJwt(creds, nowMs);
  const minted = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: 'POST', token: jwt },
  );

  tokenCache.set(installationId, {
    token: minted.token,
    expiresAtMs: Date.parse(minted.expires_at),
  });
  logger.info({ installation_id: installationId }, 'github_app_installation_token_minted');
  return minted.token;
}

export interface GithubInstallation {
  id: number;
  /** The account the App is installed ON — an org or a user. Read from here and
   *  never from what our picker suggested: `suggested_target_id` is only a
   *  suggestion, and the user can switch accounts on GitHub's own screen. */
  accountLogin: string;
  accountId: number;
  accountType: string;
  repositorySelection: 'all' | 'selected';
}

export async function getInstallation(installationId: number): Promise<GithubInstallation | null> {
  const creds = githubAppCredentials();
  if (!creds) return null;
  const raw = await githubRequest<{
    id: number;
    account: { login: string; id: number; type: string } | null;
    repository_selection: string;
  }>(`/app/installations/${installationId}`, { method: 'GET', token: mintAppJwt(creds) });

  return {
    id: raw.id,
    accountLogin: raw.account?.login ?? '',
    accountId: raw.account?.id ?? 0,
    accountType: raw.account?.type ?? 'Organization',
    repositorySelection: raw.repository_selection === 'selected' ? 'selected' : 'all',
  };
}

/**
 * The repositories an installation can actually reach.
 *
 * Only meaningful when `repositorySelection === 'selected'`. Under `all` the
 * list is every repository the account has today AND every one it gains
 * tomorrow, so storing a snapshot of it would be recording a number that starts
 * going stale immediately.
 */
export async function listInstallationRepositories(
  installationId: number,
): Promise<{ names: string[]; total: number } | null> {
  const token = await getInstallationToken(installationId);
  if (!token) return null;
  const raw = await githubRequest<{
    total_count: number;
    repositories: Array<{ full_name: string }>;
  }>('/installation/repositories?per_page=100', { method: 'GET', token });
  return {
    names: raw.repositories.map((r) => r.full_name),
    total: raw.total_count,
  };
}

/**
 * Where to send the browser to install.
 *
 * `repository_ids[]` is deliberately NOT sent. GitHub's own rule is "if
 * omitted, all repositories are selected", and All repositories is the default
 * we want: under it a repository created next month is covered automatically,
 * while under a fixed selection it is invisible until a human remembers to add
 * it, and nothing anywhere says so.
 *
 * `suggested_target_id` pre-selects the account our picker chose. It is a
 * SUGGESTION — the user can change it on GitHub's screen — so the completion
 * path must read the account off the installation rather than trusting this.
 */
export function buildInstallUrl(input: { slug: string; suggestedTargetId?: number; state: string }): string {
  const params = new URLSearchParams({ state: input.state });
  if (input.suggestedTargetId) {
    params.set('suggested_target_id', String(input.suggestedTargetId));
  }
  return `https://github.com/apps/${input.slug}/installations/new/permissions?${params.toString()}`;
}
