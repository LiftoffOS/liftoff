// Verifies every control-plane-events push subscription in the tenant
// project has a real (non-placeholder) push endpoint that responds to
// /healthz with 2xx. Exits non-zero on any failure so the deploy pipeline
// blocks until ops fixes config.
//
// Triggered by cloudbuild AFTER patch-push-sub-endpoints completes.
// Closes the failure mode where a subscription is created with a placeholder,
// the patch step is delayed or missed, every push 5xx's, and messages age out
// of the DLQ.
//
// Uses Node 18+ global `fetch`. node-fetch is NOT a tenant-runtime dependency
// (the existing platform-backend-client also uses global fetch) so we don't
// add one here.

import { v1 } from '@google-cloud/pubsub';
import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import { logger } from '../infrastructure/logging';

const PLACEHOLDER_MARKER = 'placeholder.invalid';
// 15s budget per probe absorbs Cloud Run cold-start variance. The healthcheck
// gates a deploy; false positives block all subsequent traffic, so we err on
// the side of a slightly longer wait. 5s is too tight: a single cold start
// can abort one probe and fail the whole deploy.
const HEALTHZ_TIMEOUT_MS = 15_000;
// One retry per probe with a 2s delay. Coordinator-service runs with
// min_instances=1 but autoscales aggressively; a brief blip on one container
// shouldn't fail the deploy if a second probe lands cleanly.
const PROBE_RETRIES = 1;
const RETRY_DELAY_MS = 2_000;

interface SubResult {
  name: string;
  endpoint: string;
  audience: string;
  ok: boolean;
  reason?: string;
}

// Cache OIDC token clients per audience. coordinator-service has
// `roles/run.invoker` granted to the healthcheck SA in
// terraform/projects/tenant-runtime-template/push_endpoint_healthcheck.tf;
// the request MUST carry a Google-signed ID token whose `aud` claim matches
// the Cloud Run service URL or the runtime returns 403 at the platform layer
// before our handler runs.
const auth = new GoogleAuth();
const idClientCache = new Map<string, IdTokenClient>();

async function buildOidcHeaders(audience: string): Promise<Record<string, string>> {
  let client = idClientCache.get(audience);
  if (!client) {
    client = await auth.getIdTokenClient(audience);
    idClientCache.set(audience, client);
  }
  const headers = await client.getRequestHeaders();
  // SDK returns Record<string, string|number> — normalise to strings.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function probeOnce(base: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const oidcHeaders = await buildOidcHeaders(base);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTHZ_TIMEOUT_MS);
    try {
      // Probe `/health` (not `/healthz`): Cloud Run's GFE intercepts
      // GET `/healthz` at the platform layer and returns a Google-styled 404
      // before the container ever sees the request. `/health` is mounted in
      // src/index.ts and reachable via Cloud Run normal routing.
      const r = await fetch(`${base}/health`, { signal: ctrl.signal, headers: oidcHeaders });
      if (!r.ok) return { ok: false, reason: `health ${r.status}` };
      return { ok: true };
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    return { ok: false, reason: `health fetch failed: ${(err as Error).message}` };
  }
}

async function probeHealthz(endpoint: string): Promise<{ ok: boolean; reason?: string }> {
  const base = new URL(endpoint).origin;
  let last = await probeOnce(base);
  for (let i = 0; i < PROBE_RETRIES && !last.ok; i++) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    last = await probeOnce(base);
  }
  return last;
}

export async function main(): Promise<void> {
  const project = process.env.TENANT_PROJECT;
  const env = process.env.ENVIRONMENT;
  if (!project || !env) throw new Error('TENANT_PROJECT and ENVIRONMENT required');

  const client = new v1.SubscriberClient();
  const formattedProject = client.projectPath(project);
  const [subs] = await client.listSubscriptions({ project: formattedProject });

  const results: SubResult[] = [];
  for (const sub of subs) {
    const name = sub.name ?? '';
    // Only inspect coordinator-push subscriptions we own — leave DLQ pull subs,
    // governance subs, sandbox-egress subs etc. alone.
    if (!name.endsWith(`-${env}-coordinator-push`)) continue;
    const endpoint = sub.pushConfig?.pushEndpoint ?? '';
    const audience = sub.pushConfig?.oidcToken?.audience ?? '';

    let ok = true;
    let reason: string | undefined;
    if (endpoint.includes(PLACEHOLDER_MARKER)) {
      ok = false;
      reason = 'placeholder endpoint';
    } else if (!endpoint.startsWith('https://') || !endpoint.includes('.run.app')) {
      ok = false;
      reason = `unexpected endpoint shape: ${endpoint}`;
    } else if (!audience || !endpoint.startsWith(audience)) {
      ok = false;
      reason = `oidc audience mismatch: aud=${audience} endpoint=${endpoint}`;
    } else {
      const probe = await probeHealthz(endpoint);
      if (!probe.ok) {
        ok = false;
        reason = probe.reason;
      }
    }
    results.push({ name, endpoint, audience, ok, reason });
  }

  const failed = results.filter((r) => !r.ok);
  logger.info({ checked: results.length, failed: failed.length, results }, 'healthcheck complete');
  if (failed.length > 0) {
    logger.error({ failed }, 'push-endpoint healthcheck FAILED — deploy blocked');
    process.exit(1);
  }
}

// Only run main when invoked directly (not when imported by tests).
if (require.main === module) {
  main().catch((e) => {
    logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'healthcheck crashed');
    process.exit(1);
  });
}
