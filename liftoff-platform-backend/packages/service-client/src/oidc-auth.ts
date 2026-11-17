import { GoogleAuth } from 'google-auth-library';

// Constructed lazily, not at module load. A module-level `new GoogleAuth()`
// makes this package — and every module that transitively imports it —
// impossible to unit-test without real credentials or a complete
// google-auth-library mock: the import itself throws before any test runs.
// Deferring to first use keeps the import side-effect free while preserving the
// single-instance semantics (the client cache lives in the caller).
let googleAuth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  if (!googleAuth) googleAuth = new GoogleAuth();
  return googleAuth;
}

/**
 * Build an OIDC identity-token header for a Cloud Run → Cloud Run call.
 *
 * In Cloud Run, fetching an identity token lets the target service verify
 * the caller's IAM identity via the `Authorization: Bearer <token>` header
 * — required when the target enforces `--no-allow-unauthenticated`.
 *
 * In local dev (no metadata server), returns an empty object so callers
 * can spread the result without breaking.
 */
export async function buildOidcAuthHeader(audience: string): Promise<Record<string, string>> {
  try {
    const client = await getGoogleAuth().getIdTokenClient(audience);
    const tokenHeaders = await client.getRequestHeaders();
    if (tokenHeaders.Authorization) {
      return { Authorization: tokenHeaders.Authorization };
    }
  } catch (err) {
    // In Cloud Run (K_SERVICE is set), log the failure so it's visible.
    // In local dev / test there's no metadata server — silently skip.
    if (process.env.K_SERVICE) {
      console.warn('[oidc-auth] OIDC token fetch failed for audience', audience, ':', (err as Error).message);
    }
  }
  return {};
}
