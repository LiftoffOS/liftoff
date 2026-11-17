import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from './infrastructure/logging';
import { CONNECTOR_ROLE_HINTS } from './connector-hints';
import { computeExpiresAt } from './ttl';
import { HARVEST_HIGH_CONFIDENCE_THRESHOLD } from './classifier';
import type { ClassificationResult, HarvestEvent, MemoryLayer, MemoryWriteSource } from './types';

const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL ?? 'http://localhost:3000';
const FALLBACK_TENANT_RUNTIME_URL = process.env.TENANT_RUNTIME_URL ?? 'http://localhost:4000';
const HARVEST_SERVICE_TOKEN = process.env.HARVEST_SERVICE_TOKEN ?? '';
const HARVEST_TENANT_RUNTIME_SERVICE_TOKEN = process.env.HARVEST_TENANT_RUNTIME_SERVICE_TOKEN ?? '';

const RUNTIME_URL_TTL_MS = 5 * 60 * 1000;

interface RuntimeUrlCacheEntry {
  url: string;
  expiresAt: number;
}

const runtimeUrlCache = new Map<string, RuntimeUrlCacheEntry>();

/**
 * Resolve the per-tenant runtime URL via platform-backend. Cached for 5
 * minutes per tenant. If platform-backend doesn't expose this endpoint
 * yet (404), we fall back to the env-configured TENANT_RUNTIME_URL and
 * log a warning (single-tenant dev/staging).
 */
export async function resolveRuntimeUrl(tenantId: string): Promise<string> {
  const cached = runtimeUrlCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const isProd = process.env.NODE_ENV === 'production';

  try {
    const oidcHeaders = await buildOidcAuthHeader(PLATFORM_BACKEND_URL);
    const res = await fetch(
      `${PLATFORM_BACKEND_URL}/api/internal/tenants/${tenantId}/runtime-url`,
      {
        method: 'GET',
        headers: { 'X-Service-Auth': HARVEST_SERVICE_TOKEN, ...oidcHeaders },
      },
    );
    if (res.status === 404) {
      // SEC-CRITICAL: in production, falling back to a single shared
      // TENANT_RUNTIME_URL would write tenant A's memory into tenant B's
      // runtime. Refuse to fall back when running production traffic.
      if (isProd) {
        throw new Error(
          `Cannot resolve tenant runtime URL for tenant ${tenantId}: endpoint returned ${res.status}`,
        );
      }
      log.warn(
        { tenantId },
        'platform-backend runtime-url endpoint not implemented; using TENANT_RUNTIME_URL fallback (dev only)',
      );
      const fallback = FALLBACK_TENANT_RUNTIME_URL;
      runtimeUrlCache.set(tenantId, { url: fallback, expiresAt: Date.now() + RUNTIME_URL_TTL_MS });
      return fallback;
    }
    if (!res.ok) {
      throw new Error(`runtime-url lookup failed: ${res.status}`);
    }
    const body = (await res.json()) as { url?: string; runtimeUrl?: string };
    const url = body.url ?? body.runtimeUrl;
    if (!url) {
      throw new Error('runtime-url response missing url field');
    }
    runtimeUrlCache.set(tenantId, { url, expiresAt: Date.now() + RUNTIME_URL_TTL_MS });
    return url;
  } catch (err) {
    if (isProd) {
      // Re-throw in production rather than silently routing to the wrong
      // tenant runtime. The caller (writeMemory) will surface this as a
      // pipeline failure → message nacked and retried.
      throw new Error(
        `Cannot resolve tenant runtime URL for tenant ${tenantId}: ${(err as Error).message}`,
      );
    }
    log.warn(
      { tenantId, error: (err as Error).message },
      'runtime-url resolution failed; using TENANT_RUNTIME_URL fallback (dev only)',
    );
    return FALLBACK_TENANT_RUNTIME_URL;
  }
}

async function buildMemoryHeaders(tenantId: string, targetUrl: string): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    'x-tenant-id': tenantId,
    'X-Service-Auth': HARVEST_TENANT_RUNTIME_SERVICE_TOKEN,
    ...(await buildOidcAuthHeader(targetUrl)),
  };
}

/**
 * Resolve memory layer per DESIGN-001:
 *   roleHint via CONNECTOR_ROLE_HINTS  >  result.suggestedLayer  >  'global'
 *
 * If the connector type maps to a known role, force layer='role' regardless
 * of what the classifier suggested — connectors are the strongest signal.
 */
function resolveLayer(result: ClassificationResult, connectorType: string): MemoryLayer {
  if (CONNECTOR_ROLE_HINTS[connectorType]) return 'role';
  if (result.suggestedLayer === 'global' || result.suggestedLayer === 'role') {
    return result.suggestedLayer;
  }
  return 'global';
}

function resolveRoleHint(result: ClassificationResult, connectorType: string): string | undefined {
  return CONNECTOR_ROLE_HINTS[connectorType] ?? result.roleHint;
}

export async function writeMemory(
  tenantId: string,
  result: ClassificationResult,
  event: HarvestEvent,
): Promise<string | null> {
  const runtimeUrl = await resolveRuntimeUrl(tenantId);
  const targetUrl = `${runtimeUrl}/api/memory`;

  const layer = resolveLayer(result, event.connectorType);
  const roleHint = resolveRoleHint(result, event.connectorType);
  const scopeKey = layer === 'role' ? (roleHint ?? 'harvest') : 'harvest';

  const tags = [
    `harvest:${event.connectorType}`,
    `harvest:entity:${event.entityType}`,
    `harvest:source:${event.entityId}`,
  ];
  if (result.suggestedTags && Array.isArray(result.suggestedTags)) {
    tags.push(...result.suggestedTags);
  }
  if (event.connectorId) {
    tags.push(`harvest:connector:${event.connectorId}`);
  }
  // Change A.6: high-confidence tag consumed by tenant-runtime's peer-window pull.
  if ((result.confidence ?? 0) >= HARVEST_HIGH_CONFIDENCE_THRESHOLD) {
    tags.push('harvest:high-confidence');
  }

  const source: MemoryWriteSource = {
    nodeType: 'connector_event',
    refId: event.entityId,
    connectorId: event.connectorId,
    metadata: {
      connectorType: event.connectorType,
      entityType: event.entityType,
    },
    confidence: result.confidence,
  };

  const payload: Record<string, unknown> = {
    content: result.extractedContent ?? '',
    memoryType: result.memoryType,
    layer,
    scopeKey,
    tags,
    confidence: result.confidence,
    source,
    expiresAt: computeExpiresAt(result.memoryType!),
  };
  if (roleHint) payload.roleHint = roleHint;

  const headers = await buildMemoryHeaders(tenantId, targetUrl);
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`memory write failed ${res.status}: ${body}`);
  }
  const body = (await res.json()) as { id?: string };
  return body.id ?? null;
}
