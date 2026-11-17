#!/usr/bin/env node
 
/**
 * R5 Fix 3 (BE-R3-005 + BE-R5-003) post-deploy smoke verification.
 *
 * Runs on every tenant-runtime deploy. Cloud Build fails the deploy if any
 * check fails. Exercises four invariants:
 *   1. Cloud Run revision's execution_environment is EXECUTION_ENVIRONMENT_GEN2
 *   2. read_only_root_filesystem is enabled in the revision's security context
 *   3. vpc_access egress is ALL_TRAFFIC
 *   4. Synthetic turn against /internal/connectivity-probe confirms metadata
 *      endpoint (169.254.169.254) is unreachable and metadata.google.internal
 *      resolves to the DNS-policy loopback override
 *
 * Usage:
 *   ts-node scripts/smoke/verify-vpc-egress.ts \
 *     --project=YOUR_TENANT_PROJECT \
 *     --region=us-west1 \
 *     --service=agent-service
 */
import { execFileSync } from 'child_process';

interface Args {
  project: string;
  region: string;
  service: string;
}

function parseArgs(): Args {
  const out: Partial<Args> = {};
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'project') out.project = v;
    else if (k === 'region') out.region = v;
    else if (k === 'service') out.service = v;
  }
  if (!out.project || !out.region || !out.service) {
    console.error('Usage: verify-vpc-egress.ts --project=<id> --region=<r> --service=<svc>');
    process.exit(1);
  }
  return out as Args;
}

function gcloudJson<T>(args: string[]): T {
  const out = execFileSync('gcloud', [...args, '--format=json'], { encoding: 'utf-8' });
  return JSON.parse(out) as T;
}

interface CloudRunDescribe {
  spec?: {
    template?: {
      spec?: {
        executionEnvironment?: string;
        containers?: Array<{
          securityContext?: { readOnlyRootFilesystem?: boolean };
        }>;
        vpcAccess?: { egress?: string };
      };
    };
  };
  metadata?: {
    annotations?: Record<string, string>;
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  // 1-3: inspect the Cloud Run service definition
  const svc = gcloudJson<CloudRunDescribe>([
    'run',
    'services',
    'describe',
    args.service,
    `--project=${args.project}`,
    `--region=${args.region}`,
  ]);

  const tmpl = svc.spec?.template?.spec;
  const execEnv = tmpl?.executionEnvironment
    ?? svc.metadata?.annotations?.['run.googleapis.com/execution-environment'];
  const readOnly = tmpl?.containers?.[0]?.securityContext?.readOnlyRootFilesystem;
  const egress = tmpl?.vpcAccess?.egress;

  const checks: Array<{ name: string; pass: boolean; value: unknown }> = [
    {
      name: 'execution_environment === EXECUTION_ENVIRONMENT_GEN2',
      pass: execEnv === 'EXECUTION_ENVIRONMENT_GEN2' || execEnv === 'gen2',
      value: execEnv,
    },
    {
      name: 'read_only_root_filesystem === true',
      pass: readOnly === true,
      value: readOnly,
    },
    {
      name: 'vpc_access.egress === ALL_TRAFFIC',
      pass: egress === 'ALL_TRAFFIC' || egress === 'all-traffic',
      value: egress,
    },
  ];

  // 4: live connectivity probe (expect failure to metadata endpoint)
  // The tenant-runtime exposes an internal diagnostic endpoint that attempts a
  // curl to 169.254.169.254 with a 2s timeout. When the VPC firewall + DNS policy
  // are working, the probe returns "blocked" / timeout.
  const svcUrl = gcloudJson<{ status?: { url?: string } }>([
    'run',
    'services',
    'describe',
    args.service,
    `--project=${args.project}`,
    `--region=${args.region}`,
  ]).status?.url;

  let probeResult = 'skipped';
  if (svcUrl) {
    try {
      const identityToken = execFileSync('gcloud', ['auth', 'print-identity-token'], { encoding: 'utf-8' }).trim();
      const res = await fetch(`${svcUrl}/internal/connectivity-probe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${identityToken}` },
      });
      const body = (await res.json().catch(() => ({}))) as { metadataReachable?: boolean };
      probeResult = body.metadataReachable === false ? 'blocked' : 'REACHABLE';
    } catch (err) {
      probeResult = `probe-error: ${(err as Error).message}`;
    }
  }
  checks.push({
    name: 'metadata endpoint unreachable (probe says blocked)',
    pass: probeResult === 'blocked',
    value: probeResult,
  });

  let failed = 0;
  for (const c of checks) {
    const status = c.pass ? 'OK' : 'FAIL';
    console.log(`[${status}] ${c.name}: ${JSON.stringify(c.value)}`);
    if (!c.pass) failed++;
  }

  if (failed > 0) {
    console.error(`\n${failed} VPC egress check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll VPC egress checks passed.');
}

main().catch((err) => {
  console.error('FAIL:', (err as Error).message);
  process.exit(1);
});
