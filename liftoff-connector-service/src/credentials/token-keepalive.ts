// Connector OAuth token keepalive.
//
// Direct-OAuth (static_oauth / DCR) connectors refresh their rotating tokens
// on-demand — usually kept warm by polling. But an idle connection (suspended
// tenant, write-only/unpolled connector) can lose its token past the refresh-
// token TTL and force a reconnect. This worker proactively rotates DORMANT tokens
// on a schedule (list_refreshable_credentials selects only ones not refreshed in
// 12h), independent of polling, so they never age out. It reuses the existing
// credential-service refresh path (never modifies it), takes a per-connector
// advisory lock so instances don't race, and flags genuinely-dead tokens
// (reconnect_required) by flipping connectors.status='error' — the signal the
// connections UI already renders as "Needs Reconnect".
//
// EXPLICITLY OUT OF SCOPE: `slack` (special shared config-refresh chain + the
// agent-install Slack system — never touched), composio_managed (Composio owns
// the OAuth), api_key / no-refresh-token flows (nothing to refresh). The SQL and
// the credential service both enforce these exclusions.

import type { Pool } from 'pg';
import { getPool, withTenantScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import { credentialService, OAuthRefreshError } from './service.js';
import { markConnectorReconnectRequired } from '../oauth/connector-ops.js';

/** A refresh failure that means the token is genuinely dead → flip status='error'
 *  (vs a transient network/5xx failure → retry next cycle). */
export function isReconnectRequired(err: unknown): boolean {
  return err instanceof OAuthRefreshError && err.reason === 'reconnect_required';
}

export class CredentialTokenKeepalive {
  private running = false;
  private current: Promise<unknown> = Promise.resolve();
  constructor(private readonly pool: Pool, private readonly intervalMs: number) {}

  start(): void { if (this.running) return; this.running = true; void this.loop(); }
  async stop(): Promise<void> { this.running = false; await this.current; }
  /** Run one cycle synchronously (tests / manual). Returns credentials rotated. */
  async drain(): Promise<number> { return this.iterateOnce(); }

  private async loop(): Promise<void> {
    while (this.running) {
      this.current = this.iterateOnce().catch(() => 0);
      await this.current;
      if (!this.running) break;
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }

  private async iterateOnce(): Promise<number> {
    const { rows } = await this.pool.query<{ tenant_id: string; connector_id: string; connector_type: string }>(
      `SELECT tenant_id, connector_id, connector_type FROM list_refreshable_credentials()`,
    );
    let refreshed = 0;
    for (const r of rows) {
      if (r.connector_type === 'slack') continue; // belt-and-suspenders; SQL already excludes it
      const client = await this.pool.connect();
      let locked = false;
      try {
        const lk = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
          [r.connector_id],
        );
        locked = lk.rows[0]?.locked === true;
        if (!locked) continue; // another instance is handling this connector
        await this.refreshOne(r.tenant_id, r.connector_id);
        refreshed++;
      } catch (err) {
        logger.warn({ connectorId: r.connector_id, err: (err as Error).message }, 'credential-keepalive: cycle error');
      } finally {
        if (locked) {
          await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [r.connector_id]).catch(() => undefined);
        }
        client.release();
      }
    }
    if (refreshed > 0) logger.info({ refreshed, total: rows.length }, 'credential-keepalive: cycle complete');
    return refreshed;
  }

  private async refreshOne(tenantId: string, connectorId: string): Promise<void> {
    try {
      // forceRefresh drives the EXISTING refresh path (refreshOAuth → rotate →
      // storeCredentials). Additive: no change to the on-demand/hot path.
      await credentialService.getCredentials(tenantId, connectorId, { forceRefresh: true });
      await this.markDiagnostics(tenantId, connectorId, null);
    } catch (err) {
      const dead = isReconnectRequired(err);
      // reconnect_required = genuinely dead (revoked / disconnected). Flip the
      // connector to 'error' via the SAME mechanism the on-demand path uses — the
      // connections page already renders status='error' as "Needs Reconnect". A
      // subsequent OAuth reconnect flips it back to 'active'. Anything else
      // (network / 5xx / a concurrent rotation) is transient → status untouched,
      // retry next cycle.
      if (dead) await markConnectorReconnectRequired(tenantId, connectorId);
      await this.markDiagnostics(tenantId, connectorId, (err as Error).message);
    }
  }

  // Diagnostics only — the user-facing "Needs Reconnect" signal is the connector's
  // own status ('error'), flipped above via markConnectorReconnectRequired.
  private async markDiagnostics(tenantId: string, connectorId: string, error: string | null): Promise<void> {
    await withTenantScope(tenantId, (c) =>
      c.query(
        `UPDATE connector_credentials
            SET last_refresh_error = $2, last_refresh_attempt_at = now()
          WHERE connector_id = $1`,
        [connectorId, error === null ? null : error.slice(0, 500)],
      ),
    );
  }
}

let keepalive: CredentialTokenKeepalive | null = null;

export async function startCredentialTokenKeepalive(): Promise<CredentialTokenKeepalive> {
  if (keepalive) return keepalive;
  // Every 6h: rotates any direct-OAuth token idle >12h, keeping dormant connections
  // perpetually inside their refresh-token TTL. Cheap — only genuinely idle ones.
  keepalive = new CredentialTokenKeepalive(await getPool(), 6 * 60 * 60 * 1000);
  keepalive.start();
  return keepalive;
}

export async function stopCredentialTokenKeepalive(): Promise<void> {
  if (keepalive) { await keepalive.stop(); keepalive = null; }
}
