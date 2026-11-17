// Reads CollabSkill posteriors from governance-engine.
//
// The estimator and its persisted posteriors live in governance-engine
// (src/collab-skill/service.ts there, exposed at GET /api/governance/collab-skill).
// This is the only place platform-backend reaches for them.
//
// Deliberately NOT routed through src/governance/proxy.ts. That proxy forwards
// the browser's request verbatim, including a caller-supplied x-tenant-id, and
// the mount at src/index.ts carries no tenantAuthMiddleware. A named per-person
// rating must not travel a path where the tenant is whatever the caller typed,
// so the router in this module resolves the tenant from verified membership
// first and this client is then called server-side with that verified id.

import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';

/** Mirrors SkillPosterior in governance-engine src/collab-skill/types.ts. */
export interface SkillPosterior {
  tenantId: string;
  entityType: 'agent' | 'human' | 'backbone';
  entityId: string;
  scope: string;
  mu: number;
  sigma: number;
  nObservations: number;
  lastMatchAt: string | null;
}

export interface FetchPosteriorsOptions {
  /** Swap fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Returns the posteriors for a tenant, or null when governance-engine is not
 * configured or unreachable.
 *
 * Null rather than throw: the panel degrades to its empty state, which is the
 * right outcome for a read-only insight. A 500 here would take out the whole
 * Insights page for a feature that influences no gate.
 */
export async function fetchCollabSkillPosteriors(
  tenantId: string,
  options: FetchPosteriorsOptions = {},
): Promise<SkillPosterior[] | null> {
  const base = (process.env.GOVERNANCE_SERVICE_URL ?? '').replace(/\/$/, '');
  if (!base) {
    log.warn({ tenantId }, 'score: GOVERNANCE_SERVICE_URL is not set');
    return null;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${base}/api/governance/collab-skill?tenantId=${encodeURIComponent(tenantId)}`;

  const headers: Record<string, string> = { accept: 'application/json' };
  const token = process.env.GOVERNANCE_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;

  try {
    const oidc = await buildOidcAuthHeader(new URL(url).origin);
    for (const [k, v] of Object.entries(oidc)) headers[k] = v;
  } catch (err) {
    // No metadata server in local/test. governance-engine still requires
    // X-Service-Auth, so this is survivable; in production the IAM check
    // fails loudly if the header is genuinely absent.
    log.debug({ err: (err as Error).message }, 'score: OIDC build failed');
  }

  try {
    const res = await fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      log.warn({ tenantId, status: res.status }, 'score: governance-engine returned non-ok');
      return null;
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      log.warn({ tenantId }, 'score: unexpected posterior payload');
      return null;
    }
    return body as SkillPosterior[];
  } catch (err) {
    log.error({ tenantId, err: (err as Error).message }, 'score: governance-engine unreachable');
    return null;
  }
}
