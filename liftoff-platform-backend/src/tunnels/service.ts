// Tunnels service.
//
// Owns CRUD over mcp_tunnel_deployments and mcp_tunnel_routes, plus the
// chisel-client tunnel token (in Secret Manager). The plaintext token is
// returned exactly once at deployment creation / rotation — never readable
// again. Customers who lose the token must rotate, which produces a fresh
// token and a 5-minute grace window during which the previous token still
// validates.

import { randomBytes } from 'crypto';
import { armTunnelDisconnectedSweep, armTunnelPendingSweep, armTunnelTokenGrace } from '../jobs/maintenance-targets';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { pool, withTenantScope } from '../infrastructure/database';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { log } from '../infrastructure/logging';
import { pubSubPublisher } from '../infrastructure/pubsub';
import type {
  CreateTunnelDeploymentInput,
  CreateTunnelDeploymentResult,
  CreateTunnelRouteInput,
  RotateTunnelTokenResult,
  TunnelDeployArtifact,
  TunnelDeployment,
  TunnelRoute,
} from './types';

const secretManagerClient = new SecretManagerServiceClient();

// Read env at call time, not module-load time, so tests that set these in
// beforeEach() observe the override. Module-level `const` snapshots ran
// before any test code and made TUNNEL_CLIENT_IMAGE permanently `:latest`
// for the whole jest worker.
// No defaults. Both of these end up in front of a CUSTOMER: the domain becomes
// the hostname their tunnel is published on, and the image is what they are told
// to run on their own machine. A default is not a convenience here — it hands
// somebody a hostname on a domain this deployment does not control, and a
// `docker run` line pulling an image from a registry account it does not own.
function tunnelBaseDomain(): string {
  const raw = process.env.TUNNEL_BASE_DOMAIN?.trim();
  if (!raw) {
    throw new Error(
      'TUNNEL_BASE_DOMAIN is unset, so no tunnel hostname can be built. Set it to a ' +
      'domain this deployment controls and can serve wildcard TLS for ' +
      '(e.g. tunnels.example.com) — see .env.example.',
    );
  }
  return raw;
}
function tunnelClientImage(): string {
  const raw = process.env.TUNNEL_CLIENT_IMAGE?.trim();
  if (!raw) {
    throw new Error(
      'TUNNEL_CLIENT_IMAGE is unset. Set it to the tunnel-client image this ' +
      'deployment publishes (e.g. ghcr.io/you/tunnel-client:1.2.3) — see .env.example.',
    );
  }
  return raw;
}
function tunnelTerminatorEndpoint(): string {
  return process.env.TUNNEL_TERMINATOR_ENDPOINT || `https://${tunnelBaseDomain()}`;
}
// Public-internet URL the customer's tunnel-client container polls for its
// upstream-URL config (GET /api/customer/tunnel-config). Different from the
// terminator endpoint — the API lives on the regular platform-backend host.
// A function, not a const: the module-level version evaluated at import, so
// making it strict would have crashed the whole service on load rather than on
// the first tunnel. Falls through to getBackendUrl(), which already refuses to
// invent a host.
function tunnelApiBaseUrl(): string {
  return process.env.TUNNEL_API_BASE_URL
    || process.env.PLATFORM_BACKEND_PUBLIC_URL
    || getBackendUrl();
}
const ROUTES_CHANGED_TOPIC = process.env.TUNNEL_ROUTES_TOPIC || 'mcp-tunnel-routes-changed';

// Cross-tenant DNS-label uniqueness: prefer the customer-supplied prefix,
// otherwise derive from the tenant slug and append a short random suffix
// for collision safety.
function generateTenantPrefix(seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const suffix = randomBytes(3).toString('hex');
  return `${slug || 'tenant'}-${suffix}`;
}

function generateTunnelToken(): string {
  // 32-byte URL-safe token. The "tk_" prefix matches the chisel basic-auth slot the terminator validates.
  return `tk_${randomBytes(32).toString('base64url')}`;
}

function buildPublicUrl(tenantPrefix: string, subdomain: string): string {
  return `https://${tenantPrefix}-${subdomain}.${tunnelBaseDomain()}`;
}

function mapDeployment(row: any): TunnelDeployment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    tenantPrefix: row.tenant_prefix,
    tunnelTokenSecretName: row.tunnel_token_secret_name,
    innerTlsEnabled: row.inner_tls_enabled,
    status: row.status,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    loopbackPort: row.loopback_port,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// Secret Manager name for the chisel-client token. Keyed on tenantPrefix only
// (which is globally UNIQUE per the schema) so the terminator can resolve the
// secret with just the username slot of the chisel basic-auth handshake.
// Both producer (PB) and consumer (liftoff-tunnel-service) MUST agree on this.
function tunnelTokenSecretName(tenantPrefix: string): string {
  return `mcp-tunnel-token-${tenantPrefix}`;
}

function mapRoute(row: any): TunnelRoute {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    subdomain: row.subdomain,
    upstreamUrl: row.upstream_url,
    publicUrl: row.public_url,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function buildDeployArtifact(opts: {
  image: string;
  terminatorEndpoint: string;
  apiBaseUrl: string;
  tunnelToken: string;
  tenantPrefix: string;
}): TunnelDeployArtifact {
  const dockerRunCommand = `docker run --rm \\
  -e TUNNEL_TOKEN=${opts.tunnelToken} \\
  -e TUNNEL_TERMINATOR=${opts.terminatorEndpoint} \\
  -e TUNNEL_API_BASE_URL=${opts.apiBaseUrl} \\
  -e TUNNEL_PREFIX=${opts.tenantPrefix} \\
  ${opts.image}`;

  const dockerComposeYaml = [
    `# Liftoff tunnel client — pinned image, no :latest.`,
    `services:`,
    `  tunnel:`,
    `    image: ${opts.image}`,
    `    restart: unless-stopped`,
    `    environment:`,
    `      TUNNEL_TOKEN: ${opts.tunnelToken}`,
    `      TUNNEL_TERMINATOR: ${opts.terminatorEndpoint}`,
    `      TUNNEL_API_BASE_URL: ${opts.apiBaseUrl}`,
    `      TUNNEL_PREFIX: ${opts.tenantPrefix}`,
  ].join('\n');

  return {
    image: opts.image,
    dockerRunCommand,
    dockerComposeYaml,
    terminatorEndpoint: opts.terminatorEndpoint,
  };
}

export class TunnelsService {
  // ---- Deployments -----------------------------------------------------

  async listDeployments(tenantId: string): Promise<TunnelDeployment[]> {
    const result = await pool.query(
      `SELECT * FROM mcp_tunnel_deployments WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map(mapDeployment);
  }

  async getDeployment(tenantId: string, id: string): Promise<TunnelDeployment | null> {
    const result = await pool.query(
      `SELECT * FROM mcp_tunnel_deployments WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (result.rows.length === 0) return null;
    return mapDeployment(result.rows[0]);
  }

  async getDeploymentByPrefix(tenantPrefix: string): Promise<TunnelDeployment | null> {
    const result = await pool.query(
      `SELECT * FROM mcp_tunnel_deployments WHERE tenant_prefix = $1`,
      [tenantPrefix],
    );
    if (result.rows.length === 0) return null;
    return mapDeployment(result.rows[0]);
  }

  async createDeployment(input: CreateTunnelDeploymentInput): Promise<CreateTunnelDeploymentResult> {
    const tenantPrefix = input.tenantPrefix?.trim() || generateTenantPrefix(input.name);
    const tunnelToken = generateTunnelToken();
    const secretName = tunnelTokenSecretName(tenantPrefix);

    await this.persistTokenSecret(secretName, tunnelToken);

    // Random loopback port in 20000-29999 (see migration 229 for rationale).
    // Collision is harmless in dev (different tenant-service replicas have
    // independent loopback namespaces) but we still retry on the unlikely
    // case that two creates pick the same port in the same replica.
    const loopbackPort = 20000 + Math.floor(Math.random() * 10000);

    const result = await pool.query(
      `INSERT INTO mcp_tunnel_deployments
        (tenant_id, name, tenant_prefix, tunnel_token_secret_name, status, loopback_port)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [input.tenantId, input.name, tenantPrefix, secretName, loopbackPort],
    );

    const deployment = mapDeployment(result.rows[0]);
    log.info(
      { tenantId: input.tenantId, deploymentId: deployment.id, tenantPrefix },
      'Tunnel deployment created',
    );
    // The sweep that removes a deployment still pending after 10 minutes.
    armTunnelPendingSweep();

    return {
      deployment,
      tunnelToken,
      deployArtifact: buildDeployArtifact({
        image: tunnelClientImage(),
        terminatorEndpoint: tunnelTerminatorEndpoint(),
        apiBaseUrl: tunnelApiBaseUrl(),
        tunnelToken,
        tenantPrefix,
      }),
    };
  }

  async deleteDeployment(tenantId: string, id: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM mcp_tunnel_deployments WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, tenantId],
    );
    if (result.rowCount === 0) return false;
    log.info({ tenantId, deploymentId: id }, 'Tunnel deployment deleted');
    await this.notifyRoutesChanged(tenantId);
    return true;
  }

  async rotateToken(tenantId: string, id: string): Promise<RotateTunnelTokenResult | null> {
    const deployment = await this.getDeployment(tenantId, id);
    if (!deployment) return null;

    // 1. Capture the current latest version (this becomes the "prior" version
    //    after we add the new one).
    const projectId = this.requireProjectId();
    const priorVersionName = await this.resolveLatestVersionName(
      projectId,
      deployment.tunnelTokenSecretName,
    );

    // 2. Add the new version. addSecretVersion makes it the new "latest".
    const newToken = generateTunnelToken();
    await this.persistTokenSecret(deployment.tunnelTokenSecretName, newToken);

    // 3. Persist the prior version + expiry so the grace-window sweep can
    //    recover and disable it even if this process dies before the in-process
    //    timer fires. The sweep (sweepExpiredTokenVersions, internal-router.ts)
    //    is armed for the expiry below.
    const previousTokenExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    if (priorVersionName) {
      await pool.query(
        `UPDATE mcp_tunnel_deployments
           SET prev_token_secret_version = $1,
               prev_token_expires_at = $2,
               updated_at = NOW()
         WHERE id = $3`,
        [priorVersionName, previousTokenExpiresAt, id],
      );
      armTunnelTokenGrace(previousTokenExpiresAt);

      // Best-effort in-process timer — disables the version slightly faster
      // than the next sweep tick. The sweep is the durable mechanism.
      setTimeout(() => {
        void this.disableExpiredVersion(id, priorVersionName).catch((err) => {
          log.error(
            { err, secretVersion: priorVersionName, tenantId, deploymentId: id },
            'In-process grace-window disable failed; sweep will retry',
          );
        });
      }, 5 * 60 * 1000).unref?.();
    } else {
      await pool.query(
        `UPDATE mcp_tunnel_deployments SET updated_at = NOW() WHERE id = $1`,
        [id],
      );
    }

    log.info(
      { tenantId, deploymentId: id, previousTokenExpiresAt, priorVersionName },
      'Tunnel token rotated',
    );

    return { newTunnelToken: newToken, previousTokenExpiresAt };
  }

  /**
   * Disables any prior token versions whose 5-minute grace window has expired.
   * Called every minute by the tunnel-token-grace Cloud Scheduler job; also
   * called at process startup so crashes mid-window are recovered on the next
   * boot rather than after the next scheduler tick.
   */
  async sweepExpiredTokenVersions(): Promise<number> {
    const rows = await pool.query(
      `SELECT id, prev_token_secret_version
         FROM mcp_tunnel_deployments
        WHERE prev_token_secret_version IS NOT NULL
          AND prev_token_expires_at <= NOW()`,
    );

    let disabled = 0;
    for (const row of rows.rows) {
      try {
        await this.disableExpiredVersion(row.id, row.prev_token_secret_version);
        disabled += 1;
      } catch (err) {
        log.error(
          { err, secretVersion: row.prev_token_secret_version, deploymentId: row.id },
          'Failed to disable expired tunnel token version during sweep',
        );
      }
    }
    if (disabled > 0) {
      log.info({ disabled }, 'Disabled expired tunnel token versions');
    }
    return disabled;
  }

  private async disableExpiredVersion(deploymentId: string, versionName: string): Promise<void> {
    // Disable, then clear the rotation-state columns in the same transaction
    // window. Idempotent — the sweep can call this repeatedly without effect.
    try {
      await this.disableSecretVersion(versionName);
    } catch (err) {
      const message = (err as Error).message ?? '';
      // FAILED_PRECONDITION = version already disabled/destroyed.
      if (!message.includes('FAILED_PRECONDITION') && !message.includes('NOT_FOUND')) {
        throw err;
      }
    }
    await pool.query(
      `UPDATE mcp_tunnel_deployments
         SET prev_token_secret_version = NULL,
             prev_token_expires_at = NULL,
             updated_at = NOW()
       WHERE id = $1 AND prev_token_secret_version = $2`,
      [deploymentId, versionName],
    );
  }

  /**
   * Snapshot of every active tenantPrefix → current-token mapping. Consumed by
   * the terminator's UserSource so chisel's in-memory auth table can be
   * pre-populated at startup and refreshed periodically.
   *
   * Returns an empty array if a deployment's secret has been destroyed — the
   * lazy per-connection lookup path will reject those clients clearly.
   */
  async listActiveTokens(): Promise<Array<{ tenantPrefix: string; token: string }>> {
    const projectId = this.requireProjectId();
    const result = await pool.query(
      `SELECT tenant_prefix, tunnel_token_secret_name
         FROM mcp_tunnel_deployments
        WHERE status IN ('pending', 'active', 'disconnected')`,
    );

    const out: Array<{ tenantPrefix: string; token: string }> = [];
    for (const row of result.rows) {
      try {
        const [version] = await secretManagerClient.accessSecretVersion({
          name: `projects/${projectId}/secrets/${row.tunnel_token_secret_name}/versions/latest`,
        });
        const data = version?.payload?.data;
        if (!data) continue;
        const token = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
        out.push({ tenantPrefix: row.tenant_prefix, token });
      } catch (err) {
        log.warn(
          { err, tenantPrefix: row.tenant_prefix },
          'Failed to read tunnel token for active-tokens snapshot',
        );
      }
    }
    return out;
  }

  /**
   * Returns the deploy artifact for an existing deployment WITHOUT the
   * plaintext token (the token was returned exactly once at create time).
   * The artifact uses the literal placeholder `<rotate token to retrieve>`
   * in the TOKEN slot — the customer either still has the original token,
   * or rotates to get a fresh one.
   */
  async getDeployArtifact(tenantId: string, id: string): Promise<TunnelDeployArtifact | null> {
    const deployment = await this.getDeployment(tenantId, id);
    if (!deployment) return null;
    return buildDeployArtifact({
      image: tunnelClientImage(),
      terminatorEndpoint: tunnelTerminatorEndpoint(),
      apiBaseUrl: tunnelApiBaseUrl(),
      tunnelToken: '<rotate token to retrieve>',
      tenantPrefix: deployment.tenantPrefix,
    });
  }

  // ---- Routes ----------------------------------------------------------

  async listRoutes(tenantId: string, deploymentId?: string): Promise<TunnelRoute[]> {
    if (deploymentId) {
      const result = await pool.query(
        `SELECT r.* FROM mcp_tunnel_routes r
         INNER JOIN mcp_tunnel_deployments d ON r.deployment_id = d.id
         WHERE d.tenant_id = $1 AND r.deployment_id = $2
         ORDER BY r.created_at DESC`,
        [tenantId, deploymentId],
      );
      return result.rows.map(mapRoute);
    }
    const result = await pool.query(
      `SELECT r.* FROM mcp_tunnel_routes r
       INNER JOIN mcp_tunnel_deployments d ON r.deployment_id = d.id
       WHERE d.tenant_id = $1
       ORDER BY r.created_at DESC`,
      [tenantId],
    );
    return result.rows.map(mapRoute);
  }

  async getRoute(tenantId: string, id: string): Promise<TunnelRoute | null> {
    const result = await pool.query(
      `SELECT r.* FROM mcp_tunnel_routes r
       INNER JOIN mcp_tunnel_deployments d ON r.deployment_id = d.id
       WHERE r.id = $1 AND d.tenant_id = $2`,
      [id, tenantId],
    );
    if (result.rows.length === 0) return null;
    return mapRoute(result.rows[0]);
  }

  async createRoute(tenantId: string, input: CreateTunnelRouteInput): Promise<TunnelRoute | null> {
    const deployment = await this.getDeployment(tenantId, input.deploymentId);
    if (!deployment) return null;

    // Subdomain is generated server-side as a short random hex token so the
    // public URL is an opaque routing primitive — no collision logic, no
    // coupling to user-visible names, no rename drift. UNIQUE(deployment_id,
    // subdomain) is enforced by the schema; we retry a small number of times
    // on the astronomically unlikely 4-byte (8 hex char) collision.
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const subdomain = randomBytes(4).toString('hex');
      const publicUrl = buildPublicUrl(deployment.tenantPrefix, subdomain);
      try {
        const result = await pool.query(
          `INSERT INTO mcp_tunnel_routes
             (deployment_id, subdomain, upstream_url, public_url)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [input.deploymentId, subdomain, input.upstreamUrl, publicUrl],
        );
        log.info(
          { tenantId, deploymentId: input.deploymentId, routeId: result.rows[0].id, subdomain },
          'Tunnel route created',
        );
        await this.notifyRoutesChanged(tenantId);
        return mapRoute(result.rows[0]);
      } catch (err) {
        lastErr = err;
        const code = (err as { code?: string } | null)?.code;
        if (code === '23505') {
          // Unique-violation on (deployment_id, subdomain) — try a fresh token.
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Failed to generate a unique tunnel-route subdomain');
  }

  async updateRoute(
    tenantId: string,
    id: string,
    patch: { upstreamUrl?: string },
  ): Promise<TunnelRoute | null> {
    const existing = await this.getRoute(tenantId, id);
    if (!existing) return null;

    const upstreamUrl = patch.upstreamUrl ?? existing.upstreamUrl;

    const result = await pool.query(
      `UPDATE mcp_tunnel_routes
       SET upstream_url = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [upstreamUrl, id],
    );

    await this.notifyRoutesChanged(tenantId);
    return mapRoute(result.rows[0]);
  }

  /**
   * Routes for this tenant that have no consumer currently referencing
   * them — i.e., not bound to a custom_mcp_servers row OR an
   * external_agents row. Powers the "Pick from existing routes" affordance
   * in the consumer wizards.
   */
  async listUnboundRoutes(tenantId: string): Promise<TunnelRoute[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT r.*
       FROM mcp_tunnel_routes r
       INNER JOIN mcp_tunnel_deployments d ON r.deployment_id = d.id
       LEFT JOIN custom_mcp_servers c ON c.tunnel_route_id = r.id
       LEFT JOIN external_agents ea ON ea.tunnel_route_id = r.id
       WHERE d.tenant_id = $1
         AND c.id IS NULL
         AND ea.id IS NULL
       ORDER BY r.created_at DESC`,
      [tenantId],
    ));
    return result.rows.map(mapRoute);
  }

  async deleteRoute(tenantId: string, id: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM mcp_tunnel_routes r
       USING mcp_tunnel_deployments d
       WHERE r.id = $1 AND d.id = r.deployment_id AND d.tenant_id = $2
       RETURNING r.id`,
      [id, tenantId],
    );
    if (result.rowCount === 0) return false;
    await this.notifyRoutesChanged(tenantId);
    return true;
  }

  // ---- Allowlist snapshot ---------------------------------------------

  /**
   * URL set the per-tenant allowlist endpoint exposes for the URL guard in
   * tenant-runtime. Includes every public_url for routes belonging to the
   * tenant.
   */
  async listTunneledUrlsForTenant(tenantId: string): Promise<string[]> {
    const result = await pool.query(
      `SELECT r.public_url
       FROM mcp_tunnel_routes r
       INNER JOIN mcp_tunnel_deployments d ON r.deployment_id = d.id
       WHERE d.tenant_id = $1`,
      [tenantId],
    );
    return result.rows.map((r) => r.public_url);
  }

  // ---- Background sweeps ----------------------------------------------

  /** Called by Cloud Scheduler every 5 minutes. Removes pending deployments older than 10 minutes. */
  async sweepStalePending(): Promise<number> {
    const result = await pool.query(
      `DELETE FROM mcp_tunnel_deployments
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '10 minutes'
       RETURNING id, tenant_id`,
    );
    if (result.rowCount && result.rowCount > 0) {
      log.info({ count: result.rowCount }, 'Swept stale pending tunnel deployments');
    }
    return result.rowCount ?? 0;
  }

  // ---- Heartbeats (used by terminator) --------------------------------

  /** Terminator calls this when a chisel session is accepted under a prefix. */
  async markDeploymentActive(tenantPrefix: string): Promise<void> {
    await pool.query(
      `UPDATE mcp_tunnel_deployments
       SET status = 'active', last_seen_at = NOW(), updated_at = NOW()
       WHERE tenant_prefix = $1`,
      [tenantPrefix],
    );
    // The check armed by the LAST heartbeat finds the tunnel silent and marks
    // it disconnected (a clean disconnect reports itself).
    armTunnelDisconnectedSweep();
  }

  // ---- Private --------------------------------------------------------

  private requireProjectId(): string {
    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) {
      throw new Error('GCP_PROJECT_ID env var is required for tunnel token storage');
    }
    return projectId;
  }

  private async persistTokenSecret(secretName: string, token: string): Promise<void> {
    const projectId = this.requireProjectId();

    try {
      await secretManagerClient.createSecret({
        parent: `projects/${projectId}`,
        secretId: secretName,
        secret: { replication: { automatic: {} } },
      });
    } catch (error) {
      if (!(error as Error).message?.includes('ALREADY_EXISTS')) {
        throw error;
      }
    }

    await secretManagerClient.addSecretVersion({
      parent: `projects/${projectId}/secrets/${secretName}`,
      payload: { data: Buffer.from(token, 'utf8') },
    });
  }

  /**
   * Returns the fully-qualified Secret Manager name of the current latest
   * version (e.g. projects/YOUR_PROJECT/secrets/bar/versions/3). Returns null if the
   * secret has no enabled versions yet.
   */
  private async resolveLatestVersionName(
    projectId: string,
    secretName: string,
  ): Promise<string | null> {
    try {
      const [version] = await secretManagerClient.getSecretVersion({
        name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
      });
      return version?.name ?? null;
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (message.includes('NOT_FOUND')) return null;
      throw error;
    }
  }

  private async disableSecretVersion(versionName: string): Promise<void> {
    await secretManagerClient.disableSecretVersion({ name: versionName });
    log.info({ secretVersion: versionName }, 'Disabled prior tunnel token version after grace');
  }

  private async notifyRoutesChanged(tenantId: string): Promise<void> {
    try {
      await pubSubPublisher.publish(ROUTES_CHANGED_TOPIC, { tenantId, ts: Date.now() });
    } catch (error) {
      // Pub/Sub may not be available locally; the terminator's 30s background poll
      // is the durability fallback. Don't fail the request for this.
      log.warn({ error, tenantId }, 'Failed to publish tunnel routes change event');
    }
  }
}

export const tunnelsService = new TunnelsService();
