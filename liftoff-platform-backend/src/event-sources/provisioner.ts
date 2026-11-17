// Lazy provisioner for per-agent event sources.
//
// First call from the UI's "Set up webhook" creates one row in event_sources
// and one default rule in event_trigger_rules ('*' → agent_id), and returns
// the plaintext URL token + signing secret. Both are returned to the UI
// ONCE so the user can stash them.
//
// All subsequent calls are idempotent: if a source + rule already exist for
// this agent, return the existing URL with `newSecret === null` (the secret
// cannot be re-revealed without a reset). The display name is refreshed on
// re-call so that renaming the agent eventually propagates to the source's
// user-facing label.

import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import { logAudit } from '../infrastructure/logging';
import { generateSigningSecret, generateUrlToken, secretHint } from './signing';
import { encryptSecret } from './secret-encryption';

/** Internal-only shape so callers can construct the URL string. */
export interface ProvisionedSource {
  sourceId: string;
  urlToken: string;
  /** New plaintext secret, only present on first creation. */
  newSecret: string | null;
}

/**
 * Locate an existing event_sources row for `agentId` via the default trigger
 * rule. Returns null when no source is yet provisioned.
 */
export async function findExistingSourceForAgent(
  client: PoolClient,
  tenantId: string,
  agentId: string,
): Promise<{ sourceId: string; urlToken: string } | null> {
  const r = await client.query<{ id: string; url_token: string }>(
    `SELECT s.id, s.url_token
     FROM event_sources s
     JOIN event_trigger_rules r ON r.source_id = s.id
     WHERE s.tenant_id = $1 AND r.tenant_id = $1 AND r.agent_id = $2
     LIMIT 1`,
    [tenantId, agentId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { sourceId: row.id, urlToken: row.url_token };
}

interface ProvisionInput {
  tenantId: string;
  agentId: string;
  /** Best-effort label for the source row. Defaults to "Agent webhook" when omitted. */
  agentName?: string;
  /** Route guarantees a logged-in user; actor is never null here. */
  actorUserId: string;
}

/**
 * Idempotent provisioner. Returns the existing source on re-call without
 * minting a new secret. On first call, atomically creates the source row
 * and the default trigger rule inside a single transaction. The audit row
 * lands in `audit_log` via the buffered logAudit() pipeline after the tx
 * returns — same convention as the rest of the codebase.
 */
export async function provisionForAgent(input: ProvisionInput): Promise<ProvisionedSource> {
  const result = await withTenantScope(input.tenantId, async (client) => {
    const existing = await findExistingSourceForAgent(client, input.tenantId, input.agentId);
    if (existing) {
      // Refresh the display name in case the agent was renamed since first
      // provisioning. Cheap UPDATE; no audit row because this is cosmetic.
      if (input.agentName) {
        await client.query(
          `UPDATE event_sources SET name = $1, updated_at = NOW()
           WHERE id = $2 AND tenant_id = $3 AND name <> $1`,
          [`${input.agentName} webhook`, existing.sourceId, input.tenantId],
        );
      }
      return {
        provisioned: false as const,
        sourceId: existing.sourceId,
        urlToken: existing.urlToken,
        newSecret: null,
      };
    }

    const urlToken = generateUrlToken();
    const signingSecret = generateSigningSecret();
    const ciphertext = encryptSecret(signingSecret);
    const hint = secretHint(signingSecret);
    const name = (input.agentName ?? 'Agent') + ' webhook';

    const insertSource = await client.query<{ id: string }>(
      `INSERT INTO event_sources (
         tenant_id, name, url_token, signing_secret_ciphertext, signing_secret_hint, enabled
       )
       VALUES ($1, $2, $3, $4, $5, FALSE)
       RETURNING id`,
      [input.tenantId, name, urlToken, ciphertext, hint],
    );
    const sourceId = insertSource.rows[0].id;

    await client.query(
      `INSERT INTO event_trigger_rules (tenant_id, source_id, event_type_pattern, agent_id, enabled)
       VALUES ($1, $2, '*', $3, TRUE)`,
      [input.tenantId, sourceId, input.agentId],
    );

    return { provisioned: true as const, sourceId, urlToken, newSecret: signingSecret };
  });

  if (result.provisioned) {
    logAudit('webhook.created', { tenantId: input.tenantId, userId: input.actorUserId }, {
      resourceType: 'event_source',
      resourceId: result.sourceId,
      newState: { agentId: input.agentId, sourceId: result.sourceId },
    });
  }

  return { sourceId: result.sourceId, urlToken: result.urlToken, newSecret: result.newSecret };
}

/**
 * Atomically rewrite the URL token AND the signing secret on an existing
 * source. Both new values are returned to the caller exactly once. Settings
 * (HMAC mode, rate limit, content filter, PII mode), pause state, and
 * delivery history are untouched.
 */
export async function resetCredentials(input: {
  tenantId: string;
  sourceId: string;
  actorUserId: string;
}): Promise<{ urlToken: string; newSecret: string }> {
  const urlToken = generateUrlToken();
  const signingSecret = generateSigningSecret();
  const ciphertext = encryptSecret(signingSecret);
  const hint = secretHint(signingSecret);
  const result = await withTenantScope(input.tenantId, async (client) => {
    const r = await client.query<{ id: string }>(
      `UPDATE event_sources
       SET url_token = $1, signing_secret_ciphertext = $2, signing_secret_hint = $3,
           last_reset_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING id`,
      [urlToken, ciphertext, hint, input.sourceId, input.tenantId],
    );
    if (r.rowCount === 0) {
      throw new Error('event source not found');
    }
    return { urlToken, newSecret: signingSecret };
  });

  logAudit('webhook.credentials_reset', { tenantId: input.tenantId, userId: input.actorUserId }, {
    resourceType: 'event_source',
    resourceId: input.sourceId,
    // newState carries the new URL token only; the secret is NEVER persisted
    // outside event_sources.signing_secret_ciphertext.
    newState: { sourceId: input.sourceId, urlToken: result.urlToken },
  });

  return result;
}
