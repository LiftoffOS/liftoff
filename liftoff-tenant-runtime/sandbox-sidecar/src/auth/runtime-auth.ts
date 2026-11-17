import { signSidecarJwt } from './jwt';
import { config } from '../config';
import { logger } from '../shared/logger';

// Headers for a sidecar -> runtime (sandbox-executor) callback.
//
// The runtime is deployed `--no-allow-unauthenticated --ingress internal`, so
// its Cloud Run frontend requires a valid Google OIDC ID token to invoke. We
// CANNOT put that token in `Authorization`, because that header carries the
// per-sandbox HS256 JWT the runtime's `requireSandboxJwt` validates at the app
// layer. The documented Cloud Run pattern (already used in the reverse
// direction by cloud-run-sandbox-provider) is to put the OIDC token in
// `X-Serverless-Authorization`: Cloud Run consumes it for IAM and forwards
// `Authorization` untouched to the container.
//
// The sidecar runs as the sandbox service's service account, which holds
// roles/run.invoker on the sandbox-executor service, so the metadata server
// will mint an ID token for it. Token is cached until ~5 min before expiry.
//
// Uses the link-local metadata IP rather than metadata.google.internal: the
// sandbox service runs with ALL_TRAFFIC VPC egress, under which the
// metadata.google.internal hostname is not always resolvable, whereas
// 169.254.169.254 always is.
const METADATA_IDENTITY_URL =
  `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(config.runtimeBaseUrl)}`;

let cachedOidc: { token: string; expMs: number } | null = null;

async function mintRuntimeOidc(): Promise<string | null> {
  const now = Date.now();
  if (cachedOidc && cachedOidc.expMs - now > 300_000) return cachedOidc.token;
  try {
    const res = await fetch(METADATA_IDENTITY_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ msg: 'runtime OIDC mint failed', status: res.status });
      return null;
    }
    const token = (await res.text()).trim();
    // Best-effort: read `exp` from the token to drive cache TTL; fall back to
    // ~55 min (Google ID tokens are valid ~1 h).
    let expMs = now + 3_300_000;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf-8')) as { exp?: number };
      if (payload.exp) expMs = payload.exp * 1000;
    } catch {
      /* keep default */
    }
    cachedOidc = { token, expMs };
    return token;
  } catch (err) {
    logger.warn({ msg: 'runtime OIDC mint error', err: (err as Error).message });
    return null;
  }
}

/**
 * Build the auth headers for a runtime callback: the per-sandbox HS256 JWT in
 * `Authorization` (app auth) plus, when available, a Google OIDC ID token in
 * `X-Serverless-Authorization` (Cloud Run invoker auth).
 */
export async function runtimeAuthHeaders(scopes: string[]): Promise<Record<string, string>> {
  const jwt = await signSidecarJwt(scopes);
  const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` };
  const oidc = await mintRuntimeOidc();
  if (oidc) headers['X-Serverless-Authorization'] = `Bearer ${oidc}`;
  return headers;
}
