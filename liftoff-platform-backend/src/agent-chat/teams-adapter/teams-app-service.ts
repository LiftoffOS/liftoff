// Teams app-package + Graph publish/install helpers.
//
//   buildAppPackageZip(env)        — fill the in-repo manifest template + icons,
//                                    zip server-side (jszip). Never downloaded.
//   publishAppToCatalog(token,id?) — idempotently publish OR update the app in
//                                    the customer's org catalog (create, else
//                                    update the app already there by manifest id)
//                                    with a delegated admin token. Returns the
//                                    catalog teamsApp id.
//   proactiveInstallForUser(...)   — Graph POST /users/{id}/teamwork/installedApps
//                                    (application permission) so the bot can DM a
//                                    user who hasn't added it yet.

import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { log } from '../../infrastructure/logging';
import { getBackendUrl } from '../../infrastructure/control-plane-url';
import { getGraphAppToken } from './teams-secret-service';

const ASSETS_DIR = path.join(process.cwd(), 'assets', 'teams');

/** Build the "Liftoff" Teams app package zip (manifest + icons). */
export async function buildAppPackageZip(): Promise<Buffer> {
  const appId = process.env.TEAMS_BOT_APP_ID;
  if (!appId) throw new Error('TEAMS_BOT_APP_ID not set');

  const backendUrl = getBackendUrl();
  const host = new URL(backendUrl).host;

  const template = await fs.readFile(path.join(ASSETS_DIR, 'manifest.template.json'), 'utf8');
  // Teams rejects re-publishing the same manifest version (409
  // TenantAppDefinitionManifestVersionAlreadyExists), so every publish/update
  // carries a fresh, monotonically-increasing patch (seconds since a fixed
  // 2023 epoch — stays well under the 2^31 per-part limit for decades).
  const version = `1.0.${Math.floor(Date.now() / 1000) - 1_700_000_000}`;
  const manifest = template
    .replace(/\{\{BOT_APP_ID\}\}/g, appId)
    .replace(/\{\{BACKEND_URL\}\}/g, backendUrl)
    .replace(/\{\{VALID_DOMAIN\}\}/g, host)
    .replace(/\{\{APP_VERSION\}\}/g, version);

  const [colorIcon, outlineIcon] = await Promise.all([
    fs.readFile(path.join(ASSETS_DIR, 'color.png')),
    fs.readFile(path.join(ASSETS_DIR, 'outline.png')),
  ]);

  const zip = new JSZip();
  zip.file('manifest.json', manifest);
  zip.file('color.png', colorIcon);
  zip.file('outline.png', outlineIcon);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Find the ORG-catalog app for our manifest id. Graph stamps the manifest `id`
 * (our bot app id) as the teamsApp `externalId`. We filter to
 * distributionMethod 'organization' so a leftover *sideloaded* app with the same
 * externalId (which can't be updated via appDefinitions — it 404s) never gets
 * matched. Returns the catalog teamsApp id or null.
 */
async function findOrgCatalogAppId(
  externalId: string,
  adminAccessToken: string,
): Promise<string | null> {
  const filter = `externalId eq '${externalId}' and distributionMethod eq 'organization'`;
  const res = await fetch(
    `${GRAPH}/appCatalogs/teamsApps?$filter=${encodeURIComponent(filter)}`,
    { headers: { Authorization: `Bearer ${adminAccessToken}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { value?: Array<{ id?: string }> };
  return data.value?.[0]?.id ?? null;
}

/** Publish a fresh app-definition (new version) into an existing catalog app. 204 on success. */
async function updateCatalogApp(
  catalogAppId: string,
  zip: Buffer,
  adminAccessToken: string,
): Promise<boolean> {
  const res = await fetch(`${GRAPH}/appCatalogs/teamsApps/${catalogAppId}/appDefinitions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminAccessToken}`, 'Content-Type': 'application/zip' },
    body: new Uint8Array(zip),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return true; // 204 No Content
  const err = (await res.json().catch(() => ({}))) as { error?: unknown };
  log.error({ status: res.status, error: err.error }, 'updateCatalogApp failed');
  return false;
}

/**
 * Idempotently publish (or re-publish) the app package to the customer's org
 * catalog. Requires a delegated admin token with AppCatalog.ReadWrite.All
 * (obtained in the OAuth callback).
 *
 * The catalog holds at most one app per manifest id, so a second publish must
 * UPDATE the existing app rather than POST a new one (which 409s). We resolve
 * the catalog id from the caller's last-known hint (no propagation lag) or a
 * live lookup by manifest id; update if it exists, else create — with a
 * create-race 409 fallback that re-looks-up and updates. Repeat [Set Up]
 * clicks, manifest-version bumps, and leftover sideloads all converge on the
 * same app. Returns the catalog teamsApp id.
 */
export async function publishAppToCatalog(
  adminAccessToken: string,
  knownCatalogAppId?: string | null,
): Promise<string> {
  const botAppId = process.env.TEAMS_BOT_APP_ID;
  if (!botAppId) throw new Error('TEAMS_BOT_APP_ID not set');
  const zip = await buildAppPackageZip();

  // 1. Update an existing ORG-catalog app in place if we can. A stored id can be
  //    stale (the app was removed/reinstalled) — updating it then 404s — so a
  //    FAILED update falls through to a create rather than erroring out.
  const existingId =
    knownCatalogAppId || (await findOrgCatalogAppId(botAppId, adminAccessToken));
  if (existingId && (await updateCatalogApp(existingId, zip, adminAccessToken))) {
    return existingId;
  }

  // 2. Create path.
  const res = await fetch(`${GRAPH}/appCatalogs/teamsApps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminAccessToken}`, 'Content-Type': 'application/zip' },
    body: new Uint8Array(zip),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: unknown };
  if (res.ok && data.id) return data.id;

  // 3. Create conflicted — an org-catalog app genuinely exists; find + update it
  //    (unless it's the same id whose update already failed in step 1).
  if (res.status === 409) {
    const raceId = await findOrgCatalogAppId(botAppId, adminAccessToken);
    if (raceId && raceId !== existingId && (await updateCatalogApp(raceId, zip, adminAccessToken))) {
      return raceId;
    }
  }

  log.error({ status: res.status, error: data.error }, 'publishAppToCatalog failed');
  throw new Error(`publishAppToCatalog failed: ${res.status}`);
}

/** Look up a Teams user's display name + email by aadObjectId (Graph app token). */
export async function getUserInfo(
  aadTenantId: string,
  aadUserId: string,
): Promise<{ aadUserId: string; displayName: string | null; email: string | null }> {
  const token = await getGraphAppToken(aadTenantId);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(aadUserId)}?$select=id,displayName,mail,userPrincipalName`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`getUserInfo Graph HTTP ${res.status}`);
  const u = (await res.json()) as { displayName?: string; mail?: string; userPrincipalName?: string };
  return { aadUserId, displayName: u.displayName ?? null, email: u.mail || u.userPrincipalName || null };
}

/** Fetch the replies in a Teams channel thread via Graph (app token). */
export async function getChannelThreadReplies(
  aadTenantId: string,
  teamId: string,
  channelId: string,
  messageId: string,
): Promise<Array<Record<string, unknown>>> {
  const token = await getGraphAppToken(aadTenantId);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`getChannelThreadReplies Graph HTTP ${res.status}`);
  const data = (await res.json()) as { value?: Array<Record<string, unknown>> };
  return data.value ?? [];
}

/**
 * Resolve a user's Azure AD object id from their email via Graph (app token).
 * Returns null if not found. Used by the HITL notifier to proactively install
 * the app for assignees who haven't messaged the agent yet.
 */
export async function resolveAadUserByEmail(
  aadTenantId: string,
  email: string,
): Promise<string | null> {
  try {
    const token = await getGraphAppToken(aadTenantId);
    // mail or userPrincipalName may match; $filter on mail, fall back to UPN.
    const filter = encodeURIComponent(`mail eq '${email}' or userPrincipalName eq '${email}'`);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users?$filter=${filter}&$select=id&$top=1`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: Array<{ id?: string }> };
    return data.value?.[0]?.id ?? null;
  } catch (err) {
    log.warn({ aadTenantId, err: (err as Error).message }, 'resolveAadUserByEmail failed');
    return null;
  }
}

/**
 * Proactively install the app for a user (application permission
 * TeamsAppInstallation.ReadWriteSelfForUser.All) so the bot can DM them.
 */
export async function proactiveInstallForUser(
  aadTenantId: string,
  aadUserId: string,
  teamsAppId: string,
): Promise<void> {
  const token = await getGraphAppToken(aadTenantId);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(aadUserId)}/teamwork/installedApps`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        'teamsApp@odata.bind': `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${teamsAppId}`,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  // 201 created, or 409 conflict if already installed — both fine.
  if (!res.ok && res.status !== 409) {
    const body = await res.text().catch(() => '');
    log.warn({ aadUserId, status: res.status, body }, 'proactiveInstallForUser non-OK');
  }
}

