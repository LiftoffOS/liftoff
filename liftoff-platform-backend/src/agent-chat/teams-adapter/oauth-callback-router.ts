// Microsoft identity callback for the Teams connect flow (single step).
//
// The admin runs ONE authorization-code flow (started in admin-routes'
// connect-url) that consents to the delegated AppCatalog.ReadWrite.All scope.
// We exchange the code, read the Azure AD tenant from the id_token, store the
// refresh token, publish the app package to the org catalog, and redirect the
// admin straight into Teams' add-app dialog for that app.
//
// Why one flow: core Teams chat needs no Graph *application* permissions
// (identity comes from the Bot Framework roster via TeamsInfo.getMember), so
// there is no separate /adminconsent round-trip — the admin authenticates once.

import { Router, type Request, type Response } from 'express';
import { log } from '../../infrastructure/logging';
import { getBackendUrl } from '../../infrastructure/control-plane-url';
import { upsertTenantInstall, getTenantInstall } from './repository';
import { storeAdminRefreshToken } from './teams-secret-service';
import { publishAppToCatalog } from './teams-app-service';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';
const SCOPE = 'https://graph.microsoft.com/AppCatalog.ReadWrite.All offline_access openid';

const router = Router();

function decodeState(state: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(state, 'base64url').toString());
}

function redirectUri(): string {
  return `${getBackendUrl()}/api/agent-chat/teams/oauth-callback`;
}

/**
 * Read the tenant id (`tid`) from an id_token JWT. We don't verify the token —
 * it came straight from Microsoft's token endpoint over TLS and we only need
 * the tenant to map the Azure AD tenant to the Liftoff tenant.
 */
function tenantIdFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { tid?: unknown };
    return typeof payload.tid === 'string' ? payload.tid : null;
  } catch {
    return null;
  }
}

router.get('/oauth-callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error || !state) {
    log.info({ error }, 'Teams OAuth cancelled or missing state');
    return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error&reason=consent_declined`);
  }

  let tenantId: string | undefined;
  try {
    tenantId = decodeState(state).tenantId as string | undefined;
  } catch {
    return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error`);
  }
  if (!tenantId || !code) {
    return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error&reason=missing_code`);
  }

  const appId = process.env.TEAMS_BOT_APP_ID;
  const clientSecret = process.env.TEAMS_GRAPH_CLIENT_SECRET;
  if (!appId || !clientSecret) {
    return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error&reason=server_misconfigured`);
  }

  try {
    // 1. Exchange the authorization code for a delegated token.
    const tokenRes = await fetch('https://login.microsoftonline.com/organizations/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        scope: SCOPE,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenData = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenData.access_token) {
      log.error({ tenantId, error: tokenData.error }, 'Teams admin token exchange failed');
      return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error&reason=token_exchange`);
    }

    const aadTenantId = tenantIdFromIdToken(tokenData.id_token);
    if (!aadTenantId) {
      log.error({ tenantId }, 'Teams connect: could not read tenant from id_token');
      return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error&reason=no_tenant`);
    }

    // 2. Persist the delegated refresh token (best-effort) for future re-publish.
    let refreshPath: string | null = null;
    if (tokenData.refresh_token) {
      try {
        refreshPath = await storeAdminRefreshToken(tenantId, tokenData.refresh_token);
      } catch (err) {
        log.warn({ tenantId, err: (err as Error).message }, 'Failed to store Teams admin refresh token');
      }
    }

    // 3. Store-listed apps are already installable from the Teams Store — no
    //    org-catalog publish. Record the mapping and send the admin to the app.
    if (process.env.TEAMS_STORE_LISTED === 'true') {
      await upsertTenantInstall({
        tenantId,
        azureAdTenantId: aadTenantId,
        consentState: 'published',
        graphAdminRefreshSecretPath: refreshPath,
        appPublishedAt: new Date().toISOString(),
      });
      log.info({ event: 'teams_connected_via_store', tenantId, aadTenantId }, 'Teams connected (Store install)');
      return res.redirect(
        `https://teams.microsoft.com/l/app/${encodeURIComponent(appId)}?tenantId=${encodeURIComponent(aadTenantId)}`,
      );
    }

    // 4. Publish (or re-publish) the app to the org catalog.
    let catalogTeamsAppId: string;
    try {
      const existing = await getTenantInstall(tenantId);
      catalogTeamsAppId = await publishAppToCatalog(
        tokenData.access_token,
        existing?.catalogTeamsAppId ?? null,
      );
    } catch (err) {
      log.error({ tenantId, err: (err as Error).message }, 'publishAppToCatalog failed');
      await upsertTenantInstall({ tenantId, azureAdTenantId: aadTenantId, consentState: 'error' });
      return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error&reason=publish_failed`);
    }

    await upsertTenantInstall({
      tenantId,
      azureAdTenantId: aadTenantId,
      consentState: 'published',
      catalogTeamsAppId,
      graphAdminRefreshSecretPath: refreshPath,
      appPublishedAt: new Date().toISOString(),
    });
    log.info({ event: 'teams_app_published', tenantId, aadTenantId, catalogTeamsAppId }, 'Teams app published');

    // 5. Send the admin into Teams' add-app dialog for the just-published app
    //    (org-catalog apps deep-link by their catalog id).
    return res.redirect(
      `https://teams.microsoft.com/l/app/${encodeURIComponent(catalogTeamsAppId)}?tenantId=${encodeURIComponent(aadTenantId)}`,
    );
  } catch (err) {
    log.error({ tenantId, err: (err as Error).message }, 'Teams OAuth callback error');
    return res.redirect(`${FRONTEND_URL}/dashboard/agents?teams=error`);
  }
});

export { router as teamsOAuthCallbackRouter };
