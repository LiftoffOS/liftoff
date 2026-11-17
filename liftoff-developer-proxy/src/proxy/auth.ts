// Developer Proxy Auth
// Validates liftoff_sk_* proxy keys, resolves tenant context.
// Uses auth_lookup_bypass RLS policy — no tenant scope needed for key lookup.
//
// Inbound conventions:
//   x-api-key: liftoff_sk_*                # Claude Code
//   Authorization: Bearer liftoff_sk_*     # Codex
// Requests presenting CONFLICTING credentials in both headers are rejected
// before any lookup. Neither credential form is ever logged (server.ts
// configures logger redaction for both headers).
//
// Revocation strategy (two-layer):
//   1. In-memory cache (10s TTL) — avoids DB on every hot-path request
//   2. developer_proxy_revocation_cache DB table — cross-instance signal written on revoke

import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getPool } from '../infrastructure/database.js';
import type { DevProxyAuthContext } from './types.js';

// Extend FastifyRequest with devProxyAuth
declare module 'fastify' {
  interface FastifyRequest {
    devProxyAuth?: DevProxyAuthContext;
  }
}

// ---------------------------------------------------------------------------
// Credential extraction (x-api-key and/or Authorization: Bearer)
// ---------------------------------------------------------------------------

export interface ExtractedProxyKey {
  key: string;
  source: 'x-api-key' | 'bearer';
}

export class ConflictingCredentialsError extends Error {
  statusCode = 401;
  constructor() {
    super('Conflicting credentials in x-api-key and Authorization headers');
  }
}

/**
 * Extract the presented liftoff_sk_* key from the request headers.
 * Returns null when no proxy credential is presented. Throws
 * ConflictingCredentialsError when both headers carry DIFFERENT credentials
 * (ambiguous requests fail before any upstream call).
 */
export function extractProxyKey(
  headers: Record<string, string | string[] | undefined>,
): ExtractedProxyKey | null {
  const xApiKey = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : undefined;

  const authHeader = typeof headers.authorization === 'string' ? headers.authorization : undefined;
  const bearer =
    authHeader && /^Bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^Bearer\s+/i, '').trim()
      : undefined;

  const xIsProxyKey = xApiKey?.startsWith('liftoff_sk_') ?? false;
  const bearerIsProxyKey = bearer?.startsWith('liftoff_sk_') ?? false;

  if (xIsProxyKey && bearerIsProxyKey) {
    if (xApiKey !== bearer) throw new ConflictingCredentialsError();
    return { key: xApiKey!, source: 'x-api-key' };
  }
  if (xIsProxyKey) return { key: xApiKey!, source: 'x-api-key' };
  if (bearerIsProxyKey) return { key: bearer!, source: 'bearer' };
  return null;
}

// ---------------------------------------------------------------------------
// In-memory revocation cache (10s TTL)
// ---------------------------------------------------------------------------

const REVOCATION_TTL_MS = 10_000;

interface RevocationEntry {
  revokedAt: number;
}

const revocationCache = new Map<string, RevocationEntry>();

function isRevokedInMemory(keyId: string): boolean {
  const entry = revocationCache.get(keyId);
  if (!entry) return false;
  if (Date.now() - entry.revokedAt > REVOCATION_TTL_MS) {
    revocationCache.delete(keyId);
    return false;
  }
  return true;
}

export function invalidateRevocationCache(keyId: string): void {
  revocationCache.set(keyId, { revokedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// DB revocation cache check (cross-instance — written by revokeCredential and
// by pause/resume transitions, which must propagate immediately per D1.1)
// ---------------------------------------------------------------------------

async function isRevokedInDb(keyId: string): Promise<boolean> {
  try {
    const pool = await getPool();
    const result = await pool.query<{ credential_id: string }>(
      `SELECT credential_id FROM developer_proxy_revocation_cache
       WHERE credential_id = $1 AND expires_at > NOW()`,
      [keyId],
    );
    if ((result.rowCount ?? 0) > 0) {
      // Poison in-memory cache so subsequent requests skip the DB check
      invalidateRevocationCache(keyId);
      return true;
    }
    return false;
  } catch {
    // DB error: fail open (don't block requests on revocation cache failures)
    return false;
  }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

interface DevProxyCredentialRow {
  id: string;
  tenant_id: string;
  user_id: string;
  vendor: string;
  secret_name: string;
  status: string;
}

async function lookupCredentialByKey(apiKey: string): Promise<DevProxyCredentialRow | null> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const pool = await getPool();
  const result = await pool.query<DevProxyCredentialRow>(
    `SELECT id, tenant_id, user_id, vendor, secret_name, status
     FROM developer_proxy_credentials
     WHERE key_hash = $1`,
    [keyHash],
  );
  return result.rows[0] ?? null;
}

export async function resolveByokAuth(apiKey: string): Promise<DevProxyAuthContext | null> {
  const row = await lookupCredentialByKey(apiKey);
  if (!row) return null;

  // Hot path admits only active credentials; paused credentials fail closed
  // here and can act ONLY through the self-service resume path.
  if (row.status !== 'active') return null;

  // Layer 1: in-memory revocation cache
  if (isRevokedInMemory(row.id)) return null;

  // Layer 2: DB revocation cache (cross-instance, checked on cache miss)
  if (await isRevokedInDb(row.id)) return null;

  // No last_used_at touch here. This runs on the raw pool with no GUCs, and the
  // only no-GUC policy on developer_proxy_credentials (auth_lookup_bypass,
  // migration 005) is FOR SELECT — so an UPDATE here would match zero rows on
  // every request, silently, while still costing a round trip.
  // INV-DP-006 sanctions this callsite for the key-hash lookup only.
  // Last activity is derived from developer_proxy_usage_log on the tenant-scoped
  // read paths instead (see credentials/repository.ts).

  return {
    keyId:      row.id,
    tenantId:   row.tenant_id,
    userId:     row.user_id,
    secretName: row.secret_name,
    vendor:     row.vendor,
  };
}

/**
 * Dedicated lookup for the self-service pause/resume control routes
 *: accepts `active` OR `paused` credentials so a paused key can
 * authenticate its own resume. Revoked keys remain permanently ineligible.
 * Never accepts a credential ID from the caller — only the represented key.
 */
export async function resolveByokAuthForTransition(
  apiKey: string,
): Promise<(DevProxyAuthContext & { status: 'active' | 'paused' }) | null> {
  const row = await lookupCredentialByKey(apiKey);
  if (!row) return null;
  if (row.status !== 'active' && row.status !== 'paused') return null;

  return {
    keyId:      row.id,
    tenantId:   row.tenant_id,
    userId:     row.user_id,
    secretName: row.secret_name,
    vendor:     row.vendor,
    status:     row.status,
  };
}

// ---------------------------------------------------------------------------
// Fastify auth plugin
// ---------------------------------------------------------------------------

const devProxyAuthPlugin: FastifyPluginAsync = async (app: import('fastify').FastifyInstance) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    let extracted: ExtractedProxyKey | null;
    try {
      extracted = extractProxyKey(request.headers as Record<string, string | string[] | undefined>);
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

    let context: DevProxyAuthContext | null;
    try {
      context = await resolveByokAuth(extracted.key);
    } catch (err) {
      request.log.error({ err }, 'Developer proxy auth DB error');
      return reply.code(500).send({
        type: 'error',
        error: { type: 'api_error', message: 'Internal authentication error' },
      });
    }

    if (!context) {
      return reply.code(401).send({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid or revoked API key' },
      });
    }

    request.devProxyAuth = context;
  });
};

export function createFastifyAuthPlugin(): FastifyPluginAsync {
  return fp(devProxyAuthPlugin, { name: 'dev-proxy-auth' });
}
