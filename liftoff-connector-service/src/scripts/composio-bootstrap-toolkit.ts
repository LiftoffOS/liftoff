// Composio managed-toolkit bootstrap.
//
// Idempotent, multi-env, single-toolkit-at-a-time. Run for each managed
// toolkit we want to expose as a Composio-backed connector.
//
//   Usage: npm run composio:bootstrap-toolkit -- --slug=gong
//
// Reads composio-api-key from gcloud Secret Manager (overridable via env
// vars in CI). Writes resolved IDs to config/composio-resources.json.
//
// For each (env, slug):
//   1. find-or-create a managed auth_config (Composio holds the OAuth app)
//   2. assert the auth config is in managed mode, has scopes, and no tool
//      restrictions (we never restrict at the auth_config level)
//   3. find-or-create a per-toolkit MCP server bound to that auth_config
//   4. capture toolkit metadata (toolsCount, scopes) for audit / drift detection
//
// Outputs a paste-ready catalog entry on stdout so the caller can drop it
// straight into liftoff-connector-service/src/catalog/connectors.ts.
//
// SDK shape conforms to @composio/core@0.10.x:
//   - `authConfigs.list({ toolkit, isComposioManaged })`
//   - `authConfigs.create(slug, { type: 'use_composio_managed_auth' })`
//   - `authConfigs.get(id)` returns { isComposioManaged, credentials.scopes, restrictToFollowingTools }
//   - `mcp.list({ authConfigs: [id] })`
//   - `mcp.create(name, { toolkits: [{ toolkit: slug, authConfigId }] })`
//   - `toolkits.get(slug)` returns { meta.toolsCount }

import { Composio } from '@composio/core';
import fs from 'node:fs';
import path from 'node:path';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

interface ResourceRecord {
  toolkitSlug: string;
  toolsCount: number;
  authConfigIds: { dev: string; prod: string };
  mcpServerIds: { dev: string; prod: string };
  managedScopes: string[];
}

interface ResourceFile {
  toolkits: Record<string, ResourceRecord>;
}

const RESOURCE_FILE = path.join(__dirname, '../../config/composio-resources.json');

type AuthSchemeMode = 'OAUTH2' | 'API_KEY' | 'BASIC';

// ── Secret-Manager wrapper ─────────────────────────────────────────────

let secretClient: SecretManagerServiceClient | null = null;

async function getSecretValue(env: 'dev' | 'prod'): Promise<string> {
  // CI override: prefer COMPOSIO_API_KEY_DEV / COMPOSIO_API_KEY_PROD when set
  // so the script doesn't need GCP credentials in test environments.
  const envOverride = process.env[`COMPOSIO_API_KEY_${env.toUpperCase()}`];
  if (envOverride) return envOverride;
  if (!secretClient) secretClient = new SecretManagerServiceClient();
  const projectId = `YOUR_GCP_PROJECT`;
  const name = `projects/${projectId}/secrets/composio-api-key/versions/latest`;
  const [response] = await secretClient.accessSecretVersion({ name });
  const payload = response.payload?.data?.toString();
  if (!payload) throw new Error(`Secret composio-api-key empty in ${projectId}`);
  return payload;
}

// ── Resource-file helpers ──────────────────────────────────────────────

function readResourceFile(): ResourceFile {
  if (!fs.existsSync(RESOURCE_FILE)) {
    return { toolkits: {} };
  }
  const raw = fs.readFileSync(RESOURCE_FILE, 'utf8');
  return JSON.parse(raw) as ResourceFile;
}

function upsertResourceFile(record: ResourceRecord): void {
  const file = readResourceFile();
  file.toolkits[record.toolkitSlug] = record;
  fs.writeFileSync(
    RESOURCE_FILE,
    JSON.stringify(file, null, 2) + '\n',
    'utf8',
  );
}

function printPasteableCatalogEntry(record: ResourceRecord, authScheme: AuthSchemeMode): void {
  const authBlock = authScheme !== 'OAUTH2'
    ? `  auth: { kind: 'api_key' },`
    : `  auth: {
    kind: 'static_oauth',
    clientIdEnvVar: 'COMPOSIO_MANAGED',
    clientSecretEnvVar: 'COMPOSIO_MANAGED',
    authUrl: 'https://composio.dev',
    tokenUrl: 'https://composio.dev',
    scopes: [],
    scopeDelimiter: ' ',
  },`;
  const entry = `// Paste-ready catalog entry for ${record.toolkitSlug}:
{
  type: '<liftoff_connector_type>',
  displayName: '<Display Name>',
  category: '<connector_category>',
  status: 'available',
${authBlock}
  mcp: {
    kind: 'composio_managed',
    toolkitSlug: '${record.toolkitSlug}',
    authConfigIds: { dev: '${record.authConfigIds.dev}', prod: '${record.authConfigIds.prod}' },
    mcpServerIds: { dev: '${record.mcpServerIds.dev}', prod: '${record.mcpServerIds.prod}' },
    transport: 'streamable-http',
  },
},`;
  console.log('\n' + entry);
}

// ── Composio orchestration ─────────────────────────────────────────────

interface BootstrapEnvResult {
  authConfigId: string;
  mcpServerId: string;
  toolsCount: number;
  scopes: string[];
}

async function bootstrapEnv(
  env: 'dev' | 'prod',
  slug: string,
  authScheme: AuthSchemeMode,
): Promise<BootstrapEnvResult> {
  const apiKey = await getSecretValue(env);
  const composio = new Composio({ apiKey });

  const managed = authScheme === 'OAUTH2';

  // 1. find-or-create auth_config.
  // OAUTH2  → Composio-managed auth (Composio holds the upstream OAuth app).
  // API_KEY → custom auth (use_custom_auth); the per-tenant API/App keys are
  //           submitted at connect time via connectedAccounts.initiate, not here.
  // Refuse to proceed if more than one matching auth_config exists for the
  // same toolkit — picking one arbitrarily would point the catalog at a
  // resource the operator didn't intend. Require manual dedup.
  const existing = await composio.authConfigs.list(
    managed
      ? { toolkit: slug, isComposioManaged: true }
      : { toolkit: slug },
  );
  // For custom (API_KEY) auth, the list isn't filtered server-side by managed
  // flag, so narrow to our own non-managed config by name.
  const candidates = managed
    ? existing.items
    : existing.items.filter(
        (it) => it.isComposioManaged !== true && it.name === `liftoff-${slug}`,
      );
  if (candidates.length > 1) {
    const ids = candidates.map((it) => it.id).join(', ');
    throw new Error(
      `Multiple auth_configs found for toolkit ${slug} in env ${env}: [${ids}]. ` +
      `Delete the duplicates in the Composio dashboard before re-running this script — ` +
      `the catalog can reference exactly one per (toolkit, env).`,
    );
  }
  let authConfigId = candidates[0]?.id;
  if (!authConfigId) {
    const created = managed
      ? await composio.authConfigs.create(slug, {
          type: 'use_composio_managed_auth',
          name: `liftoff-${slug}`,
        })
      : await composio.authConfigs.create(slug, {
          type: 'use_custom_auth',
          authScheme,
          // Per-tenant keys are supplied at connect time; the auth_config
          // itself carries no shared credentials (datadog_api_key has
          // auth_config_creation.required = []).
          credentials: {},
          name: `liftoff-${slug}`,
        });
    authConfigId = created.id;
  }

  // 2. Shape assertions.
  const ac = await composio.authConfigs.get(authConfigId);
  if (managed && ac.isComposioManaged === false) {
    // `isComposioManaged` is optional in the SDK type — checking strict
    // `=== false` catches a clear non-managed state without false-positiving
    // on undefined.
    throw new Error(`auth config ${authConfigId} is not managed (isComposioManaged=false)`);
  }
  const credScopes = (ac.credentials as { scopes?: string | string[] } | undefined)?.scopes;
  const scopeList: string[] = Array.isArray(credScopes)
    ? credScopes
    : typeof credScopes === 'string' && credScopes.length > 0
      ? [credScopes]
      : [];
  // OAuth scopes only apply to managed auth. Many managed toolkits also encode
  // scopes inside the upstream OAuth app rather than on the auth_config, so a
  // warn (not a throw) is the honest signal there. API_KEY auth has no scopes.
  if (managed && scopeList.length === 0) {
    console.warn(
      `auth config ${authConfigId} has no scopes on the SDK response — relying on Composio-side defaults`,
    );
  }
  if (ac.restrictToFollowingTools?.length) {
    throw new Error(`auth config has tool restrictions: ${ac.restrictToFollowingTools.join(',')}`);
  }

  // 3. find-or-create per-toolkit MCP server bound to this auth config.
  // MCPListParams is typed as the zod-output shape (defaults already
  // applied) so every field is required at the call site even though the
  // wire payload only needs `authConfigs`.
  //
  // Same dedup contract as auth_configs: exactly one MCP server per
  // (toolkit, env). If we find multiples, refuse — the catalog can only
  // point at one and silently picking is a footgun.
  const servers = await composio.mcp.list({
    page: 1,
    limit: 50,
    toolkits: [],
    authConfigs: [authConfigId],
  });
  if (servers.items.length > 1) {
    const ids = servers.items.map((it) => it.id).join(', ');
    throw new Error(
      `Multiple MCP servers found for auth_config ${authConfigId} (toolkit ${slug}, env ${env}): [${ids}]. ` +
      `Delete the duplicates in the Composio dashboard before re-running.`,
    );
  }
  let mcpServerId = servers.items[0]?.id;
  if (!mcpServerId) {
    // Composio MCP server names allow only letters, numbers, spaces, and
    // hyphens — slugs with underscores must be sanitized. The server is
    // found-or-created by authConfig binding above, not by name, so renaming
    // is idempotency-safe.
    const created = await composio.mcp.create(`liftoff-${slug.replace(/_/g, '-')}`, {
      toolkits: [{ toolkit: slug, authConfigId }],
      manuallyManageConnections: true, // we drive linking from /start, not the MCP server
    });
    mcpServerId = created.id;
  }

  // 4. Pull toolkit metadata
  const toolkit = await composio.toolkits.get(slug);

  return {
    authConfigId,
    mcpServerId,
    toolsCount: toolkit.meta?.toolsCount ?? 0,
    scopes: scopeList,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────

function parseArgs(): { slug: string; authScheme: AuthSchemeMode; envs: ('dev' | 'prod')[] } {
  const slugArg = process.argv.find((a) => a.startsWith('--slug='));
  if (!slugArg) {
    console.error('Usage: composio-bootstrap-toolkit --slug=<toolkit_slug> [--auth-scheme=OAUTH2|API_KEY] [--env=dev|prod|dev,prod]');
    process.exit(2);
  }
  const schemeArg = process.argv.find((a) => a.startsWith('--auth-scheme='));
  const authScheme = (schemeArg?.slice('--auth-scheme='.length) ?? 'OAUTH2').toUpperCase();
  if (authScheme !== 'OAUTH2' && authScheme !== 'API_KEY' && authScheme !== 'BASIC') {
    console.error(`Invalid --auth-scheme=${authScheme} (expected OAUTH2, API_KEY, or BASIC)`);
    process.exit(2);
  }
  // --env lets us provision dev before prod sign-off. Defaults to both.
  const envArg = process.argv.find((a) => a.startsWith('--env='));
  const envs = (envArg ? envArg.slice('--env='.length).split(',') : ['dev', 'prod'])
    .map((e) => e.trim())
    .filter((e): e is 'dev' | 'prod' => e === 'dev' || e === 'prod');
  if (envs.length === 0) {
    console.error('Invalid --env (expected dev and/or prod)');
    process.exit(2);
  }
  return { slug: slugArg.slice('--slug='.length), authScheme, envs };
}

async function main(slug: string, authScheme: AuthSchemeMode, envs: ('dev' | 'prod')[]): Promise<void> {
  // Preserve the IDs of any env we're NOT bootstrapping this run (e.g. a
  // dev-only run must not clobber an existing prod entry, and vice versa).
  const existing = readResourceFile().toolkits[slug];
  const devResult = envs.includes('dev') ? await bootstrapEnv('dev', slug, authScheme) : null;
  const prodResult = envs.includes('prod') ? await bootstrapEnv('prod', slug, authScheme) : null;

  if (devResult && prodResult && devResult.toolsCount !== prodResult.toolsCount) {
    console.warn(
      `Toolkit tool count mismatch dev=${devResult.toolsCount} prod=${prodResult.toolsCount}`,
    );
  }

  const ref = devResult ?? prodResult!;
  const record: ResourceRecord = {
    toolkitSlug: slug,
    toolsCount: ref.toolsCount,
    authConfigIds: {
      dev: devResult?.authConfigId ?? existing?.authConfigIds.dev ?? '',
      prod: prodResult?.authConfigId ?? existing?.authConfigIds.prod ?? '',
    },
    mcpServerIds: {
      dev: devResult?.mcpServerId ?? existing?.mcpServerIds.dev ?? '',
      prod: prodResult?.mcpServerId ?? existing?.mcpServerIds.prod ?? '',
    },
    managedScopes: ref.scopes,
  };

  upsertResourceFile(record);
  console.log(JSON.stringify(record, null, 2));
  printPasteableCatalogEntry(record, authScheme);
}

// Bootstrap doesn't touch the DB pool, but the Composio SDK keeps an
// undici Agent + Secret Manager client alive. Same fix as
// composio-migrate-reconnect: force-exit so the script doesn't hang
// when invoked from CI or a Cloud Run task with a wall-clock timeout.
const parsed = parseArgs();
main(parsed.slug, parsed.authScheme, parsed.envs)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
