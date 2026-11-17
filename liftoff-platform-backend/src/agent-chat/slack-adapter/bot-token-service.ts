// Slack bot token service — canonical storage of the workspace app's bot
// token in Secret Manager.
//
// One Liftoff app per environment serves every agent (ADR-040), so there is
// one token per (tenant, workspace). The per-agent tokens this module used to
// mint are gone with the per-agent apps.
//
// Naming convention
// -----------------
// Secret ID: slack-ws-bot-{tenantIdShort}-{teamId}, where {tenantIdShort} is
// the first 12 chars of the UUID (dashes stripped) — long enough to avoid
// collisions within a project, short enough to stay under Secret Manager's
// 255-char limit.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from '../../infrastructure/logging';

const smClient = new SecretManagerServiceClient();
const SM_PROJECT = process.env.GCP_PROJECT_ID;

// In-process LRU-ish cache for hot bot tokens. Keyed by secret path; TTL
// 5 min mirrors the platform's other Secret Manager caches and matches the
// horizon over which a bot token's revocation should propagate.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
interface CacheEntry { token: string; cachedAt: number }
const tokenCache = new Map<string, CacheEntry>();

function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 12);
}

/** Secret id for a workspace install's bot token (one per tenant+workspace). */
export function buildWorkspaceSecretId(
  tenantId: string,
  slackTeamId: string,
): string {
  return `slack-ws-bot-${shortId(tenantId)}-${slackTeamId}`;
}

function secretParent(): string {
  if (!SM_PROJECT) throw new Error('GCP_PROJECT_ID not set');
  return `projects/${SM_PROJECT}`;
}

function secretName(secretId: string): string {
  return `${secretParent()}/secrets/${secretId}`;
}

function secretLatestVersion(secretId: string): string {
  return `${secretName(secretId)}/versions/latest`;
}

/**
 * Store the workspace app's bot token and return its canonical version path,
 * which is what slack_workspace_installs.slack_bot_token_secret_path holds.
 */
export async function storeWorkspaceBotToken(
  tenantId: string,
  slackTeamId: string,
  botToken: string,
): Promise<string> {
  return storeTokenSecret({
    secretId: buildWorkspaceSecretId(tenantId, slackTeamId),
    labels: {
      purpose: 'slack-workspace-bot-token',
      tenant: shortId(tenantId),
    },
    botToken,
    logContext: { tenantId, slackTeamId },
  });
}

async function storeTokenSecret(input: {
  secretId: string;
  labels: Record<string, string>;
  botToken: string;
  logContext: Record<string, string>;
}): Promise<string> {
  const { secretId, labels, botToken, logContext } = input;
  const parent = secretParent();

  // Create the secret container if missing. ALREADY_EXISTS is fine — we
  // just add a new version below (expected on re-install into the same
  // workspace).
  try {
    await smClient.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} }, labels },
    });
    log.info({ secretId, ...logContext },
      'Created Secret Manager container for Slack bot token');
  } catch (err) {
    const code = (err as { code?: number }).code;
    // gRPC code 6 = ALREADY_EXISTS.
    if (code !== 6) {
      throw new Error(
        `Failed to create Secret Manager secret ${secretId}: ${(err as Error).message}`,
      );
    }
  }

  // Add the new version with the raw token payload.
  const [version] = await smClient.addSecretVersion({
    parent: secretName(secretId),
    payload: { data: Buffer.from(botToken, 'utf-8') },
  });

  const versionPath = version.name;
  if (!versionPath) {
    throw new Error(`addSecretVersion returned no name for ${secretId}`);
  }

  // Invalidate any cached value for this secret — the new install token
  // supersedes anything we may have just looked up.
  for (const key of tokenCache.keys()) {
    if (key.startsWith(secretName(secretId))) tokenCache.delete(key);
  }

  log.info({ secretId, version: versionPath, ...logContext },
    'Stored Slack bot token in Secret Manager');

  // Return the /versions/latest path (not the pinned version path) so
  // future reads always get the most recently rotated token without
  // requiring a DB update on rotation.
  return secretLatestVersion(secretId);
}

/**
 * Read a Slack bot token from Secret Manager.
 *
 * Accepts either a full version path (e.g.
 * "projects/.../secrets/.../versions/latest") or a bare secret ID. In-
 * process TTL cache mirrors infrastructure/secrets.ts behaviour.
 */
export async function readBotTokenFromSecretManager(
  secretPath: string,
): Promise<string> {
  const name = secretPath.includes('/versions/')
    ? secretPath
    : secretLatestVersion(secretPath);

  const cached = tokenCache.get(name);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.token;
  }

  const [response] = await smClient.accessSecretVersion({ name });
  const token = response.payload?.data?.toString();
  if (!token) {
    throw new Error(`Secret ${name} has no payload`);
  }

  // Soft LRU eviction
  if (tokenCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = tokenCache.keys().next().value;
    if (firstKey) tokenCache.delete(firstKey);
  }
  tokenCache.set(name, { token, cachedAt: Date.now() });

  return token;
}

/**
 * Resolve a workspace install's bot token. Null when the row has no secret
 * path or the secret cannot be read — callers treat that as "not installed".
 */
export async function resolveWorkspaceBotToken(install: {
  id: string;
  tenantId: string;
  slackTeamId: string;
  slackBotTokenSecretPath: string | null;
}): Promise<string | null> {
  if (!install.slackBotTokenSecretPath) return null;
  try {
    return await readBotTokenFromSecretManager(install.slackBotTokenSecretPath);
  } catch (err) {
    log.error(
      {
        installId: install.id,
        tenantId: install.tenantId,
        slackTeamId: install.slackTeamId,
        secretPath: install.slackBotTokenSecretPath,
        error: (err as Error).message,
      },
      'Failed to read workspace Slack bot token from Secret Manager',
    );
    return null;
  }
}

/** Test-only: clear the in-process token cache. */
export function _clearBotTokenCache(): void {
  tokenCache.clear();
}
