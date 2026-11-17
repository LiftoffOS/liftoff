// Liftoff Switch — migration API client.
//
// The CLI's half of the orchestration contract (plan §7). Conversion and
// activation are deliberately NOT called from here: both happen after payment
// and after an explicit user confirmation in the browser, so the CLI's job is
// to create/resume a migration, upload a redacted bundle, and read state.

import type { MigrationBundleV1, MigrationSource } from './contract';
import type { MigrationState } from './local-state';

const API_BASE_URL = process.env.LIFTOFF_API_URL || 'https://api.example.com';

export interface MigrationRequirement {
  kind: 'credential' | 'collaboration' | 'consent' | 'payment' | 'hosting' | 'selection';
  detail: string;
  /** Where the user resolves it, relative to the app. */
  resolvePath?: string;
}

export interface MigrationItemView {
  sourceRef: string;
  role: string;
  state: 'pending' | 'distilling' | 'creating' | 'converted' | 'failed';
  destinationAgentId?: string;
  lastError?: string;
}

export interface MigrationView {
  id: string;
  source: MigrationSource;
  state: MigrationState;
  itemCount: number;
  convertedCount: number;
  unsupportedCount: number;
  items: MigrationItemView[];
  requirements: MigrationRequirement[];
  /** Present once the wizard has somewhere to send the user. */
  webPath: string;
  /** Whether the workspace has finished standard onboarding. The wizard runs
   *  only after onboarding completes in this release, and the server is the
   *  authority on that: the CLI must not infer it. */
  onboardingComplete: boolean;
}

async function request<T>(
  method: string,
  path: string,
  firebaseToken: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${firebaseToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    // A body-size rejection comes back as HTML from the proxy, not JSON, so
    // parsing it yields "HTTP 413" and the person is told nothing about what to
    // do. Name the cause: it is the one failure here they can act on.
    if (res.status === 413) {
      throw new Error(
        'This installation is too large for Liftoff to accept in one upload. Nothing was ' +
          'imported and nothing was charged. Please contact support so we can size the import ' +
          'for your installation.',
      );
    }
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error || `${method} ${path} failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

/** Create or resume a migration. Idempotent on (tenant, source, fingerprint):
 *  a second call for the same installation returns the existing migration
 *  rather than starting a parallel one. */
export async function createOrResumeMigration(
  firebaseToken: string,
  params: {
    tenantId: string;
    source: MigrationSource;
    installationFingerprint: string;
    sourceVersion?: string;
    adapterVersion: string;
  },
): Promise<MigrationView> {
  return request<MigrationView>('POST', '/api/source-migrations', firebaseToken, params);
}

/** Upload the versioned, redacted bundle. */
export async function uploadBundle(
  firebaseToken: string,
  migrationId: string,
  tenantId: string,
  bundle: MigrationBundleV1,
): Promise<MigrationView> {
  return request<MigrationView>(
    'PUT',
    `/api/source-migrations/${migrationId}/bundle`,
    firebaseToken,
    { tenantId, bundle },
  );
}

export async function getMigration(
  firebaseToken: string,
  migrationId: string,
  tenantId: string,
): Promise<MigrationView> {
  return request<MigrationView>(
    'GET',
    `/api/source-migrations/${migrationId}?tenantId=${encodeURIComponent(tenantId)}`,
    firebaseToken,
  );
}
