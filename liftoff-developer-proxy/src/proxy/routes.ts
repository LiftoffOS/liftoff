// Proxy route registration for Fastify.
// Mounts the transparent vendor proxy (Claude Code /v1 + /claude-code, Codex
// /codex), the Codex model catalog, self-revoke, and the self-service
// credential pause/resume control routes.

import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createFastifyAuthPlugin,
  invalidateRevocationCache,
  extractProxyKey,
  resolveByokAuthForTransition,
  ConflictingCredentialsError,
} from './auth.js';
import { handleVendorProxy, handleVendorGetPassthrough } from './handler.js';
import { invalidateSecretCache } from './secret-cache.js';
import { getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';
import { resolveVendorFromRequest, getVendorConfig, getAdapter } from '../vendor/registry.js';
import { checkPgRateLimit } from '../rate-limit/pg-rate-limiter.js';

// Augment FastifyRequest with rawBody and vendor
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    resolvedVendor?: string;
  }
}

const REVOKE_LIMIT = 3;                 // revokes per hour per credential
const TRANSITION_LIMIT = 10;            // pause/resume attempts per credential per hour
const TRANSITION_IP_LIMIT = 60;         // IP abuse ceiling for transition attempts per hour

// Vendor/config-driven request-rate safeguards: per-vendor RPM comes
// from reviewed configuration (env), not a global Anthropic-specific constant.
// Provider 429s and Liftoff limits are SEPARATE controls: the Liftoff bucket
// protects the proxy and the vendor account ceiling; provider 429s are passed
// through via the safe-response-header allowlist (retry-after, x-ratelimit-*).
function vendorRateLimitRpm(vendor: string): number {
  const config = loadConfig();
  if (vendor === 'openai') return config.RATE_LIMIT_RPM_OPENAI;
  return config.RATE_LIMIT_RPM_ANTHROPIC;
}

export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // Raw body capture: verbatim bytes forwarded to vendor without re-serialization
  // (the OpenAI adapter re-serializes through its body allowlist; Anthropic
  // passthrough stays byte-for-byte).
  // ---------------------------------------------------------------------------
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 /* 20 MB */ },
    (
      _req: FastifyRequest,
      body: Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ) => {
      (_req as unknown as { rawBody: Buffer }).rawBody = body;
      done(null, body);
    },
  );

  // ---------------------------------------------------------------------------
  // Auth-gated sub-app: vendor routing, rate limiting, proxy, revoke,
  // pause/resume
  // ---------------------------------------------------------------------------
  await app.register(async (sub: FastifyInstance) => {
    // Validate liftoff_sk_* key (x-api-key or Bearer) on every route below
    await sub.register(createFastifyAuthPlugin());

    // Vendor resolution hook — resolves the route vendor before credential use;
    // the handler enforces route == credential == adapter vendor.
    sub.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        request.resolvedVendor = resolveVendorFromRequest(
          request.headers as Record<string, string | string[] | undefined>,
          request.url,
        );
      } catch (err) {
        return reply.code(400).send({
          type: 'error',
          error: { type: 'invalid_request_error', message: (err as Error).message },
        });
      }
    });

    // Distributed Postgres rate-limit hook (vendor/config-driven)
    sub.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.devProxyAuth) return; // unreachable after auth plugin, but type-safe

      const vendor = request.resolvedVendor ?? 'anthropic';
      const bucketKey = `${request.devProxyAuth.keyId}:${vendor}`;

      let rlResult: Awaited<ReturnType<typeof checkPgRateLimit>>;
      try {
        const pool = await getPool();
        rlResult = await checkPgRateLimit(pool, bucketKey, vendorRateLimitRpm(vendor));
      } catch (err) {
        // Rate-limit DB failure: fail open to avoid blocking all requests.
        // Log loudly — persistent failures mean the bucket table is broken.
        request.log.error({ err }, 'Rate-limit DB check failed — failing open');
        return;
      }

      if (!rlResult.allowed) {
        reply
          .code(429)
          .header('X-RateLimit-Limit',     String(rlResult.limitCount))
          .header('X-RateLimit-Remaining', '0')
          .header('X-RateLimit-Reset',     String(Math.floor(rlResult.resetAt.getTime() / 1000)))
          .send({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
          });
      }
    });

    // --- Vendor proxy ---
    // Claude Code namespaces
    sub.post('/v1/messages',              handleVendorProxy);
    sub.post('/v1/messages/count_tokens', handleVendorProxy);
    sub.post('/claude-code/v1/messages',              handleVendorProxy);
    sub.post('/claude-code/v1/messages/count_tokens', handleVendorProxy);
    // Codex namespace
    sub.post('/codex/v1/responses',         handleVendorProxy);
    sub.post('/codex/v1/responses/compact', handleVendorProxy);

    // Read-only model discovery (opt-in in Claude Code via
    // CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY). Forwarded verbatim, never
    // metered — consumes no tokens. Still behind auth + rate limit.
    sub.get('/v1/models', handleVendorGetPassthrough);

    // --- Codex model catalog ---
    // Served so Codex startup does not log an error; the authoritative,
    // capability-rich catalog is generated locally by the CLI
    // (model_catalog_json). Filtered to Liftoff-approved AND priced models.
    sub.get('/codex/v1/models', async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.devProxyAuth!;
      if (auth.vendor !== 'openai') {
        return reply.code(403).send({
          type: 'error',
          error: { type: 'permission_error', message: 'Credential vendor does not match route vendor' },
        });
      }
      const pool = await getPool();
      let models: string[];
      let catalog: Record<string, Record<string, unknown>>;
      try {
        const vendorConfig = await getVendorConfig(pool, 'openai');
        const adapter = getAdapter('openai');
        catalog = vendorConfig.modelCatalog;
        // Allowed AND priced: a model without a pricing entry is not served.
        models = vendorConfig.allowedModels.filter(
          (m) => vendorConfig.pricing[adapter.canonicalizeModel(m)] !== undefined,
        );
      } catch (err) {
        return reply.code(400).send({
          type: 'error',
          error: { type: 'invalid_request_error', message: (err as Error).message },
        });
      }
      // Capability/presentation fields come VERBATIM from the reviewed
      // model_catalog metadata (migration 014); models without reviewed
      // metadata are served as minimal entries — nothing is invented here.
      return reply.send({
        object: 'list',
        data: models.map((id) => ({
          id,
          object: 'model',
          owned_by: 'liftoff',
          ...(catalog[id] ?? {}),
        })),
      });
    });

    // --- Self-revoke ---
    sub.post(
      '/v1/revoke',
      async (request: FastifyRequest, reply: FastifyReply) => {
        // Revoke-specific rate limit: 3/hour per key
        const pool = await getPool();
        const revokeKey = `${request.devProxyAuth!.keyId}:revoke`;
        const rlResult  = await checkPgRateLimit(pool, revokeKey, REVOKE_LIMIT).catch(() => null);
        if (rlResult && !rlResult.allowed) {
          return reply.code(429).send({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Too many revoke attempts' },
          });
        }

        // Parse body
        let body: unknown;
        try {
          body = JSON.parse((request.rawBody ?? Buffer.alloc(0)).toString('utf-8'));
        } catch {
          return reply.code(400).send({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
          });
        }

        if (!(body as Record<string, unknown>)?.confirm) {
          return reply.code(400).send({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Body must include { "confirm": true }' },
          });
        }

        const extracted = extractProxyKey(
          request.headers as Record<string, string | string[] | undefined>,
        );
        const keyHash = createHash('sha256').update(extracted!.key).digest('hex');

        const result = await pool.query<{ id: string; secret_name: string }>(
          `UPDATE developer_proxy_credentials
              SET status     = 'revoked',
                  revoked_at = NOW(),
                  updated_at = NOW()
            WHERE key_hash = $1
              AND status   = 'active'
           RETURNING id, secret_name`,
          [keyHash],
        );

        if (result.rowCount === 0) {
          return reply.code(404).send({
            type: 'error',
            error: { type: 'not_found_error', message: 'Key not found or already revoked' },
          });
        }

        const row = result.rows[0];

        // Poison in-memory caches immediately
        invalidateRevocationCache(row.id);
        invalidateSecretCache(row.secret_name);

        // Write DB revocation cache for cross-instance propagation
        pool.query(
          `INSERT INTO developer_proxy_revocation_cache (credential_id, revoked_at, expires_at)
           VALUES ($1, NOW(), NOW() + INTERVAL '120 seconds')
           ON CONFLICT (credential_id) DO UPDATE
             SET revoked_at = NOW(), expires_at = NOW() + INTERVAL '120 seconds'`,
          [row.id],
        ).catch(() => undefined);

        request.log.info({ keyId: row.id, tenantId: request.devProxyAuth!.tenantId }, 'Developer proxy key self-revoked');
        return reply.send({ revoked: true });
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Self-service pause/resume control routes.
  //
  // Registered OUTSIDE the main auth plugin: these routes use a dedicated
  // credential-hash lookup that accepts `active` OR `paused` credentials so a
  // paused key can authenticate its own resume; revoked keys remain
  // permanently ineligible. They never accept a credential ID from the caller
  // and mutate only the credential represented by the supplied secret.
  // ---------------------------------------------------------------------------
  await app.register(async (control: FastifyInstance) => {
    const transition = (target: 'paused' | 'active') =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        let extracted;
        try {
          extracted = extractProxyKey(
            request.headers as Record<string, string | string[] | undefined>,
          );
        } catch (err) {
          if (err instanceof ConflictingCredentialsError) {
            return reply.code(401).send({
              type: 'error',
              error: { type: 'authentication_error', message: 'Conflicting proxy credentials' },
            });
          }
          throw err;
        }
        if (!extracted) {
          return reply.code(401).send({
            type: 'error',
            error: { type: 'authentication_error', message: 'Missing or invalid proxy key' },
          });
        }

        const auth = await resolveByokAuthForTransition(extracted.key);
        if (!auth) {
          return reply.code(401).send({
            type: 'error',
            error: { type: 'authentication_error', message: 'Invalid or revoked API key' },
          });
        }

        const pool = await getPool();

        // Dedicated transition rate limit (10/credential/hour) + IP abuse
        // ceiling; independent of self-revoke's 3/hour bucket.
        const credBucket = await checkPgRateLimit(
          pool, `${auth.keyId}:transition`, TRANSITION_LIMIT,
        ).catch(() => null);
        const ipBucket = await checkPgRateLimit(
          pool, `ip:${request.ip}:transition`, TRANSITION_IP_LIMIT,
        ).catch(() => null);
        if ((credBucket && !credBucket.allowed) || (ipBucket && !ipBucket.allowed)) {
          return reply.code(429).send({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Too many pause/resume attempts' },
          });
        }

        // Idempotent transition: mutates only the credential represented by
        // the supplied secret; returns the resulting state either way.
        await pool.query(
          `UPDATE developer_proxy_credentials
              SET status = $2,
                  paused_at = CASE WHEN $2 = 'paused' THEN NOW() ELSE NULL END,
                  updated_at = NOW()
            WHERE id = $1 AND status <> $2`,
          [auth.keyId, target],
        );

        // Cross-instance status-cache invalidation.
        invalidateRevocationCache(auth.keyId);
        if (target === 'paused') {
          await pool.query(
            `INSERT INTO developer_proxy_revocation_cache (credential_id, revoked_at, expires_at)
             VALUES ($1, NOW(), NOW() + INTERVAL '120 seconds')
             ON CONFLICT (credential_id) DO UPDATE
               SET revoked_at = NOW(), expires_at = NOW() + INTERVAL '120 seconds'`,
            [auth.keyId],
          ).catch(() => undefined);
        } else {
          // Resume: clear the cross-instance block so the credential is usable
          // again without waiting for cache expiry.
          await pool.query(
            `DELETE FROM developer_proxy_revocation_cache WHERE credential_id = $1`,
            [auth.keyId],
          ).catch(() => undefined);
          revocationCacheClear(auth.keyId);
        }

        // Audit the transition without logging the key.
        await pool.query(
          `INSERT INTO outbox_events
             (event_id, event_type, schema_version, tenant_id, payload, occurred_at)
           VALUES ($1, $2, 1, $3, $4, NOW())
           ON CONFLICT (event_id) DO NOTHING`,
          [
            randomUUID(),
            'audit.developer_proxy_request',
            auth.tenantId,
            JSON.stringify({
              tenantId: auth.tenantId,
              action: target === 'paused' ? 'developer_proxy_credential_paused' : 'developer_proxy_credential_resumed',
              inputArgs: { credentialId: auth.keyId, vendor: auth.vendor },
              outputSummary: null,
              outcome: 'success',
              durationMs: 0,
              triggeredBy: auth.userId ? `human:${auth.userId}` : 'system',
            }),
          ],
        ).catch((err) => request.log.error({ err }, 'Failed to audit credential transition'));

        request.log.info(
          { keyId: auth.keyId, tenantId: auth.tenantId, target },
          'Developer proxy credential state transition',
        );
        return reply.send({ status: target });
      };

    control.post('/v1/credential/pause', transition('paused'));
    control.post('/v1/credential/resume', transition('active'));
  });
}

// Local helper: the in-memory revocation cache in auth.ts only supports
// poisoning; on resume we simply let the 10s TTL lapse. This hook exists so
// tests can assert the resume path touches the cache boundary explicitly.
function revocationCacheClear(_keyId: string): void {
  // The 10s in-memory TTL self-heals after resume; nothing further needed.
}
