// BigQuery keyless onboarding — per-tenant service-account provisioning
// (implementation plan §5).
//
// The keyless model: the Cloud Run runtime SA (ADC) impersonates a per-tenant
// service account `wh-<tenant>@<control-project>.iam.gserviceaccount.com`; the
// customer grants THAT SA `roles/bigquery.dataViewer` + `roles/bigquery.jobUser`
// on THEIR project/dataset (one revocable binding, shown in the connect UX).
// No service-account keys are ever minted or stored.
//
// This module ensures the per-tenant SA exists and that the runtime SA can
// impersonate it (`roles/iam.serviceAccountTokenCreator` ON the per-tenant SA).
// Both are idempotent. The customer-side grant is done by the customer (we only
// render copy-paste instructions), so nothing here touches the customer project.
//
// Requires the runtime SA to hold, on the CONTROL project:
//   roles/iam.serviceAccountAdmin (create SAs + setIamPolicy on them).
// Declare that in Terraform (see docs/operations.md); it is a control-project
// grant, not a customer grant.

import { GoogleAuth } from 'google-auth-library';
import { logger } from '../infra/logging.js';

const IAM_BASE = 'https://iam.googleapis.com/v1';
const TOKEN_CREATOR_ROLE = 'roles/iam.serviceAccountTokenCreator';

/**
 * Control project that HOSTS the per-tenant SAs (not the customer's project).
 * Prefers WAREHOUSE_SA_PROJECT, then GOOGLE_CLOUD_PROJECT, then the metadata
 * server's project id (auth.getProjectId()) so no env config is required on
 * Cloud Run — GOOGLE_CLOUD_PROJECT is NOT auto-set there (caught by the dev
 * BigQuery E2E: provisioning threw "must be set" until derived from metadata).
 */
async function controlProject(auth: GoogleAuth): Promise<string> {
  const p =
    process.env.WAREHOUSE_SA_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    (await auth.getProjectId().catch(() => undefined));
  if (!p) throw new Error('cannot determine control project for BigQuery SA provisioning; set WAREHOUSE_SA_PROJECT');
  return p;
}

/**
 * Deterministic, GCP-valid SA account id for a tenant. GCP account ids are
 * 6–30 chars, must start with a lowercase letter, and allow [a-z0-9-]. Tenant
 * ids are 36-char UUIDs, so we strip dashes and truncate the hex to fit
 * `wh-<27hex>` = 30 chars. Deterministic (same tenant → same SA) and collision-
 * safe at 27 hex chars.
 */
export function serviceAccountIdForTenant(tenantId: string): string {
  const hex = tenantId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `wh-${hex.slice(0, 27)}`;
}

/** Full SA email for a tenant in a given control project. */
export function serviceAccountEmailForTenant(tenantId: string, project: string): string {
  return `${serviceAccountIdForTenant(tenantId)}@${project}.iam.gserviceaccount.com`;
}

/** The runtime SA that will impersonate the per-tenant SA (ADC identity).
 *  Prefers WAREHOUSE_RUNTIME_SA, else the metadata server's default SA email
 *  (getCredentials().client_email) — robust across dev/prod without hardcoding. */
async function runtimeServiceAccountEmail(auth: GoogleAuth): Promise<string> {
  if (process.env.WAREHOUSE_RUNTIME_SA) return process.env.WAREHOUSE_RUNTIME_SA;
  const creds = await auth.getCredentials().catch(() => ({} as { client_email?: string }));
  const email = creds.client_email;
  if (!email) {
    throw new Error(
      'cannot determine runtime SA email for BigQuery impersonation grant; set WAREHOUSE_RUNTIME_SA',
    );
  }
  return email;
}

async function iamFetch<T>(auth: GoogleAuth, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const token = await auth.getAccessToken();
  const res = await fetch(`${IAM_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

interface IamPolicy {
  bindings?: Array<{ role: string; members: string[] }>;
  etag?: string;
  version?: number;
}

/**
 * Idempotently ensure the per-tenant SA exists and the runtime SA can
 * impersonate it. Returns the per-tenant SA email to store on the connector
 * config + render in the connect UX. Safe to call on every (re)connect.
 */
export async function ensurePerTenantServiceAccount(tenantId: string): Promise<string> {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const project = await controlProject(auth);
  const accountId = serviceAccountIdForTenant(tenantId);
  const email = serviceAccountEmailForTenant(tenantId, project);
  const saResource = `projects/${project}/serviceAccounts/${email}`;

  // 1. Create the SA if absent (409 = already exists → fine).
  const get = await iamFetch(auth, `/${saResource}`);
  if (get.status === 404) {
    const create = await iamFetch<{ error?: { message?: string } }>(
      auth,
      `/projects/${project}/serviceAccounts`,
      {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          serviceAccount: { displayName: `Liftoff warehouse reader (tenant ${tenantId})` },
        }),
      },
    );
    if (create.status !== 200 && create.status !== 409) {
      throw new Error(`bigquery_sa_create_failed ${create.status}: ${create.body?.error?.message ?? 'unknown'}`);
    }
    logger.info({ tenantId, email }, 'bigquery: per-tenant SA created');
  } else if (get.status >= 400) {
    throw new Error(`bigquery_sa_lookup_failed ${get.status}`);
  }

  // 2. Grant the runtime SA tokenCreator ON this SA (idempotent read-modify-write).
  const runtimeSa = await runtimeServiceAccountEmail(auth);
  const member = `serviceAccount:${runtimeSa}`;
  const pol = await iamFetch<IamPolicy>(auth, `/${saResource}:getIamPolicy`, { method: 'POST', body: '{}' });
  const policy: IamPolicy = pol.body ?? {};
  const bindings = policy.bindings ?? [];
  let binding = bindings.find((b) => b.role === TOKEN_CREATOR_ROLE);
  const alreadyGranted = binding?.members?.includes(member) ?? false;
  if (!alreadyGranted) {
    if (!binding) {
      binding = { role: TOKEN_CREATOR_ROLE, members: [] };
      bindings.push(binding);
    }
    binding.members.push(member);
    const set = await iamFetch<{ error?: { message?: string } }>(
      auth,
      `/${saResource}:setIamPolicy`,
      { method: 'POST', body: JSON.stringify({ policy: { ...policy, bindings } }) },
    );
    if (set.status !== 200) {
      throw new Error(`bigquery_sa_grant_failed ${set.status}: ${set.body?.error?.message ?? 'unknown'}`);
    }
    logger.info({ tenantId, runtimeSa, email }, 'bigquery: granted runtime SA tokenCreator on per-tenant SA');
  }

  return email;
}

/** Copy-paste grant the customer runs on THEIR project (rendered in the UX). */
export function customerGrantInstructions(serviceAccountEmail: string, projectId: string): string {
  return [
    `gcloud projects add-iam-policy-binding ${projectId} \\`,
    `  --member="serviceAccount:${serviceAccountEmail}" \\`,
    `  --role="roles/bigquery.dataViewer"`,
    ``,
    `gcloud projects add-iam-policy-binding ${projectId} \\`,
    `  --member="serviceAccount:${serviceAccountEmail}" \\`,
    `  --role="roles/bigquery.jobUser"`,
  ].join('\n');
}
