// Starting a GitHub App install, and listing where it could go.
//
// TWO ENDPOINTS, BOTH SERVING ONE DECISION THE UI CANNOT MAKE ALONE.
//
// At the moment someone clicks Connect we know nothing about their GitHub
// account, and — more importantly — we cannot know which organization they will
// choose, because that choice happens on GitHub's own installation screen.
//
// That would be survivable if the outcome told us. It does not. When the user
// is not an owner, GitHub records a request and returns `setup_action=request`
// with NO organization name, and when an owner approves later the
// `installation.created` webhook carries no reference to who asked. GitHub
// support has confirmed there is no way to correlate them.
//
// So we ask FIRST. `/install-targets` reads the user's organizations and their
// role from the token the authorize leg already stored, and `/install-start`
// records the org they picked before sending them to GitHub. That single extra
// screen is what lets the pending card name the organization it is waiting on,
// and what gives the later webhook something to match against.

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '../infra/logging.js';
import { withTenantScope } from '../db/pool.js';
import { credentialService } from '../credentials/service.js';
import { findUsableConnectorByTenantAndType } from './connector-ops.js';
import { githubAppCredentials, buildInstallUrl } from './github-app.js';
import type { OAuthStateRow } from './connector-ops.js';

export const githubAppInstallRouter = Router();

interface InstallTarget {
  id: number;
  login: string;
  type: 'User' | 'Organization';
  /** Whether this person can install without anyone else's approval. Drives the
   *  "Needs owner approval" label, so the consequence is stated BEFORE they
   *  commit rather than discovered afterwards. */
  canInstall: boolean;
}

async function githubGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'liftoff-connector-service',
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`github GET ${path}: ${resp.status} ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

/**
 * Where this person could install the App, and whether they can do it
 * themselves.
 *
 * Uses the stored OAuth USER token, which already carries `read:org`. That is
 * deliberate: a GitHub App's own user-to-server token is governed by App
 * permissions rather than OAuth scopes, so asking through the App could return
 * an empty list — and an empty picker looks identical to "you have no
 * organizations", which is the confident-wrong-answer shape this whole area
 * exists to avoid.
 */
githubAppInstallRouter.get('/install-targets', async (req: Request, res: Response) => {
  const tenantId = String(req.query.tenantId ?? '');
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

  const connector = await findUsableConnectorByTenantAndType(tenantId, 'github');
  if (!connector) {
    return res.status(409).json({ error: 'github_not_connected' });
  }

  try {
    const creds = await credentialService.getCredentials(tenantId, connector.id);
    const token = creds.accessToken;
    if (!token) return res.status(409).json({ error: 'github_no_user_token' });

    const [user, memberships] = await Promise.all([
      githubGet<{ id: number; login: string }>('/user', token),
      githubGet<Array<{ role: string; organization: { id: number; login: string } }>>(
        '/user/memberships/orgs?state=active&per_page=100',
        token,
      ),
    ]);

    const targets: InstallTarget[] = [
      // A personal account is always installable by its owner, and is listed
      // first because it is the only target that never needs anyone else.
      { id: user.id, login: user.login, type: 'User', canInstall: true },
      ...memberships.map((m) => ({
        id: m.organization.id,
        login: m.organization.login,
        type: 'Organization' as const,
        canInstall: m.role === 'admin',
      })),
    ];

    return res.json({ targets });
  } catch (err) {
    const message = (err as Error).message ?? '';
    logger.error({ err: message, tenantId }, 'github_install_targets_failed');
    // A missing credential is not GitHub being down, and saying so sends the
    // reader to check GitHub's status page instead of the connector. The
    // frontend contract already distinguishes these, and mapping everything to
    // 502 makes the UI render "GitHub could not be reached" for a row that simply
    // holds no token, which points an investigation away from connector
    // resolution.
    if (/no credentials found/i.test(message)) {
      return res.status(409).json({ error: 'github_no_user_token' });
    }
    return res.status(502).json({ error: 'github_unreachable' });
  }
});

/**
 * Mint the state and hand back the URL the popup should open.
 *
 * The state is `gha_`-prefixed so `/callback` can discriminate this branch the
 * same way the Composio branch keys on `cmp_`.
 */
githubAppInstallRouter.post('/install-start', async (req: Request, res: Response) => {
  const { tenantId, accountId, redirectUri, targetId, targetLogin } = req.body ?? {};
  if (!tenantId || !redirectUri || !targetLogin) {
    return res.status(400).json({ error: 'tenantId, redirectUri and targetLogin are required' });
  }

  const creds = githubAppCredentials();
  if (!creds) {
    // Honest 503 rather than a URL that would 404 on github.com.
    return res.status(503).json({ error: 'github_app_not_configured' });
  }

  const state = `gha_${crypto.randomBytes(24).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `INSERT INTO connector_oauth_states
         (state, tenant_id, account_id, connector_type, scopes, redirect_uri, code_verifier, expires_at, extra)
         VALUES ($1, $2, $3, 'github', $4, $5, NULL, $6, $7)`,
      [
        state,
        tenantId,
        accountId ?? '',
        JSON.stringify([]),
        redirectUri,
        expiresAt,
        // `targetLogin` is the ONLY record of which org was asked for. GitHub
        // never sends it back on the request path, so this row is what makes a
        // pending card nameable and a later webhook attributable.
        JSON.stringify({ githubTargetLogin: targetLogin, githubTargetId: targetId ?? null }),
      ],
    );
  });

  return res.json({
    installUrl: buildInstallUrl({
      slug: creds.slug,
      suggestedTargetId: typeof targetId === 'number' ? targetId : undefined,
      state,
    }),
  });
});

/** Shape of what the `/callback` branch reads back out of `extra`. */
export interface GithubInstallStateExtra {
  githubTargetLogin?: string;
  githubTargetId?: number | null;
}

export function readInstallStateExtra(row: OAuthStateRow): GithubInstallStateExtra {
  return (row.extra ?? {}) as GithubInstallStateExtra;
}
