// OIDC token helpers for the integration suite.
//
// Two callers, two audiences, two SAs:
//
//   getRuntimeOidc(audience)   — token from the CI SA. Used for endpoints
//                                that allowlist the CI SA (currently none —
//                                kept for forward compatibility).
//
//   getSchedulerOidc(audience) — token IMPERSONATED from the Cloud Scheduler
//                                SA. Used for PB's /reconcile-runtime-state
//                                which gates on email === CLOUD_SCHEDULER_SA.
//                                Requires the CI SA to hold
//                                roles/iam.serviceAccountTokenCreator on the
//                                scheduler SA.

import { GoogleAuth, Impersonated } from 'google-auth-library';

export async function getRuntimeOidc(audience: string): Promise<string> {
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const authz = headers['Authorization'] ?? headers['authorization'];
  if (!authz?.startsWith('Bearer ')) {
    throw new Error('getRuntimeOidc: no Bearer token in returned headers');
  }
  return authz.slice('Bearer '.length);
}

export async function getSchedulerOidc(audience: string): Promise<string> {
  const schedSa = process.env.INTEGRATION_SCHEDULER_SA_EMAIL;
  if (!schedSa) {
    throw new Error(
      'getSchedulerOidc: INTEGRATION_SCHEDULER_SA_EMAIL not set. ' +
      'Configure it on the workflow env to the cloud-scheduler-<env>@... SA email.',
    );
  }
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const source = await auth.getClient();
  const impersonated = new Impersonated({
    sourceClient: source,
    targetPrincipal: schedSa,
    targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
    delegates: [],
  });
  const token = await impersonated.fetchIdToken(audience);
  if (!token) {
    throw new Error('getSchedulerOidc: impersonation produced empty id_token');
  }
  return token;
}
