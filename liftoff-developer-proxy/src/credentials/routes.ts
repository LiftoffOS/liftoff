// Developer Proxy Credential Management Routes
// Two authenticated callers:
//   - platform-backend (the /api/claude-code-proxy front door) — Cloud Run IAM
//     via OIDC plus a shared X-Service-Token, acting for the user in x-user-id.
//   - the CLI setup-exchange (exempt; the one-time setupToken is the secret).
// A direct Firebase-JWT browser path is also honoured for local/legacy use.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../infrastructure/config.js';
import { getPool } from '../infrastructure/database.js';
import { verifyIdToken } from '../infrastructure/firebase.js';
import { resolveServiceToken } from '../infrastructure/service-token.js';
import * as service from './service.js';

interface AuthedRequest extends FastifyRequest {
  userId: string;
}

// Active credentials are counted PER VENDOR: the webhook must never
// report the combined Anthropic+OpenAI total under both integration types.
async function getActiveKeyCount(tenantId: string, vendor: string): Promise<number> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM developer_proxy_credentials
      WHERE tenant_id = $1 AND vendor = $2 AND status = 'active'`,
    [tenantId, vendor],
  );
  return parseInt(result.rows[0].count as string, 10);
}

// Integration type derived from the credential vendor, using
// Platform Backend's existing `claude_code | codex` enum.
function integrationTypeForVendor(vendor: string): 'claude_code' | 'codex' {
  return vendor === 'openai' ? 'codex' : 'claude_code';
}

// Platform Backend's actual contract:
// POST /api/internal/developer-proxy-hook with X-Developer-Proxy-Webhook-Token.
//
// Awaited inside the request, never fired after it: on request-based CPU a
// fetch left running after the reply stalls until the next request. Bounded by
// INTEGRATION_WEBHOOK_TIMEOUT_MS and best-effort, so a slow or failing Platform
// Backend delays the reply by at most that and never fails it.
export const INTEGRATION_WEBHOOK_TIMEOUT_MS = 3_000;

export async function notifyIntegration(
  event: 'credential.created' | 'credential.revoked',
  tenantId: string,
  vendor: string,
): Promise<void> {
  const config = loadConfig();
  if (!config.PLATFORM_BACKEND_URL) return;

  try {
    const activeKeyCount = await getActiveKeyCount(tenantId, vendor);
    await fetch(`${config.PLATFORM_BACKEND_URL}/api/internal/developer-proxy-hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Developer-Proxy-Webhook-Token': config.BYOK_WEBHOOK_TOKEN_SECRET,
      },
      body: JSON.stringify({
        event,
        tenantId,
        type: integrationTypeForVendor(vendor),
        activeKeyCount,
      }),
      signal: AbortSignal.timeout(INTEGRATION_WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    // Best-effort: the integration status catches up on the next change.
  }
}

export async function registerCredentialRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // setup-exchange — exempt from Firebase JWT (CLI callers have no browser JWT)
  // The setupToken itself is a 32-byte one-time random value sufficient for security.
  // ---------------------------------------------------------------------------
  app.post('/credentials/setup-exchange', async (request: FastifyRequest, reply: FastifyReply) => {
    // The proxy registers a raw-Buffer application/json parser on the ROOT app
    // for verbatim vendor passthrough. This route lives on the root (it must be
    // exempt from the credential sub-plugin's Firebase/service auth), so
    // request.body arrives as a Buffer, not parsed JSON — parse it explicitly.
    let body: { setupToken?: string; codeVerifier?: string };
    try {
      const raw = request.body as unknown;
      body = Buffer.isBuffer(raw)
        ? JSON.parse(raw.toString('utf-8'))
        : ((raw as { setupToken?: string; codeVerifier?: string }) ?? {});
    } catch {
      return reply.code(400).send({ error: 'Invalid JSON body' });
    }

    if (!body?.setupToken) {
      return reply.code(400).send({ error: 'setupToken is required' });
    }

    const result = await service.exchangeSetupToken(body.setupToken, body.codeVerifier);
    if (!result) {
      return reply.code(404).send({ error: 'Setup token expired, invalid, or PKCE mismatch' });
    }

    return reply.send({
      fullKey: result.fullKey,
      proxyBaseUrl: result.proxyBaseUrl,
    });
  });

  // ---------------------------------------------------------------------------
  // All other credential routes — require Firebase JWT
  // ---------------------------------------------------------------------------
  await app.register(async (sub: FastifyInstance) => {
    sub.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.headers['x-tenant-id'] as string | undefined;
      if (!tenantId) {
        return reply.code(400).send({ error: 'x-tenant-id header required' });
      }

      // Service-to-service path: platform-backend authenticates with the shared
      // service token (the network hop is already IAM-gated via OIDC) and names
      // the acting user in x-user-id. Trusted caller — no Firebase JWT needed.
      const serviceToken = request.headers['x-service-token'];
      if (typeof serviceToken === 'string' && serviceToken.length > 0) {
        let expectedToken: string;
        try {
          expectedToken = await resolveServiceToken();
        } catch (err) {
          request.log.error({ err }, 'Failed to resolve service token');
          return reply.code(500).send({ error: 'Internal auth error' });
        }
        if (serviceToken !== expectedToken) {
          return reply.code(401).send({ error: 'Invalid service token' });
        }
        const userId = request.headers['x-user-id'] as string | undefined;
        if (!userId) {
          return reply.code(400).send({ error: 'x-user-id header required for service calls' });
        }
        (request as AuthedRequest).userId = userId;
        return;
      }

      // Browser path: Firebase JWT in Authorization.
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Authorization: Bearer <firebase-jwt> required' });
      }

      const token = authHeader.slice(7);
      try {
        const decoded = await verifyIdToken(token);

        // Defense in depth: if the token carries a tenant claim, verify it matches the header.
        const claimedTenant = (decoded as Record<string, unknown>)['tenant_id'] as string | undefined;
        if (claimedTenant && claimedTenant !== tenantId) {
          return reply.code(403).send({ error: 'Tenant mismatch' });
        }

        (request as AuthedRequest).userId = decoded.uid;
      } catch {
        return reply.code(401).send({ error: 'Invalid or expired Firebase token' });
      }
    });

    // POST /credentials — create a new developer proxy credential.
    // Vendor-neutral contract: { vendor, apiKey, label }, with
    // anthropicApiKey preserved for backward compatibility.
    sub.post('/credentials', async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.headers['x-tenant-id'] as string;
      const { userId } = request as AuthedRequest;
      const body = request.body as {
        apiKey?: string;
        anthropicApiKey?: string;
        vendor?: string;
        label?: string;
      };

      const rawKey = body?.apiKey ?? body?.anthropicApiKey;
      if (!rawKey) {
        return reply.code(400).send({ error: 'apiKey is required' });
      }
      const vendor = body?.vendor ?? 'anthropic';
      if (vendor !== 'anthropic' && vendor !== 'openai') {
        return reply.code(400).send({ error: 'vendor must be anthropic or openai' });
      }

      try {
        const result = await service.createCredential({
          tenantId,
          userId,
          apiKey: rawKey,
          vendor,
          label: body.label,
        });

        await notifyIntegration('credential.created', tenantId, vendor);

        return reply.code(201).send(result);
      } catch (error) {
        const message = (error as Error).message;
        if (message === 'Invalid Anthropic API key' || message === 'Invalid OpenAI API key') {
          return reply.code(400).send({ error: message });
        }
        request.log.error({ error: message, tenantId, userId }, 'Failed to create credential');
        return reply.code(500).send({ error: 'Failed to create credential' });
      }
    });

    // GET /credentials — list credentials for a tenant
    sub.get('/credentials', async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.headers['x-tenant-id'] as string;
      const { userId } = request as AuthedRequest;
      const query = request.query as { all?: string };
      const userFilter = query.all === 'true' ? undefined : userId;
      const credentials = await service.listCredentials(tenantId, userFilter);
      return reply.send({ credentials });
    });

    // GET /credentials/pending-setup-token — the caller's most recent unexpired
    // setup token (declared before /:id so it isn't shadowed). Used by the
    // CLI-auth page to hand the CLI its token without a browser localStorage
    // dependency. Auth (service-token or Firebase) identifies the user.
    sub.get('/credentials/pending-setup-token', async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.headers['x-tenant-id'] as string;
      const { userId } = request as AuthedRequest;
      const token = await service.getPendingSetupToken(tenantId, userId);
      if (!token) return reply.code(404).send({ error: 'No pending setup token' });
      return reply.send({ setupToken: token });
    });

    // GET /credentials/:id — get single credential
    sub.get('/credentials/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.headers['x-tenant-id'] as string;
      const { userId } = request as AuthedRequest;
      const { id } = request.params as { id: string };
      const credential = await service.getCredential(id, tenantId, userId);
      if (!credential) return reply.code(404).send({ error: 'Credential not found' });
      return reply.send(credential);
    });

    // DELETE /credentials/:id — revoke a credential
    sub.delete('/credentials/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.headers['x-tenant-id'] as string;
      const { userId } = request as AuthedRequest;
      const { id } = request.params as { id: string };
      const { revoked, vendor } = await service.revokeCredential(id, tenantId, userId);
      if (!revoked) return reply.code(404).send({ error: 'Credential not found or already revoked' });

      const revokedVendor = vendor ?? 'anthropic';
      await notifyIntegration('credential.revoked', tenantId, revokedVendor);

      return reply.send({ revoked: true });
    });

    // POST /credentials/pkce-bind — bind code_challenge to setup token (browser-called)
    sub.post('/credentials/pkce-bind', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        setupToken?: string;
        codeChallenge?: string;
      };
      if (!body?.setupToken || !body?.codeChallenge) {
        return reply.code(400).send({ error: 'setupToken and codeChallenge are required' });
      }
      const bound = await service.bindCodeChallenge(body.setupToken, body.codeChallenge);
      if (!bound) return reply.code(404).send({ error: 'Setup token expired or invalid' });
      return reply.send({ bound: true });
    });
  });
}
