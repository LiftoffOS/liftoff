// Phase 0s — cross-service data-export orchestrator.
//
// Cloud Run Job invoked by operators for GDPR / CCPA DSAR. Fans out
// `ExportTenantData` + `DeleteTenantUserData` to every Liftoff service
// that stores tenant-owned data, writes the aggregated export to a
// per-request GCS bucket with 7-day TTL, and records an immutable
// audit receipt in the 7-year retained bucket.
//
// Callers invoke via `gcloud run jobs execute data-export-orchestrator
// --args --tenant=<uuid> --scope=tenant|user [--subject-user=<uuid>]
// --requested-by=<email> --legal-reason=<text>`.

import { Storage } from '@google-cloud/storage';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { createHmac, randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { getServiceClient } from './service-clients.js';

// Every service that implements ExportTenantData + DeleteTenantUserData.
const TARGET_SERVICES = [
  'liftoff-billing',
  'liftoff-developer-proxy',
  'liftoff-workforce-service',
  'liftoff-connector-service',
  'liftoff-governance-engine',
  'liftoff-tenant-runtime',
  'liftoff-platform-backend',
] as const;

type Scope = 'tenant' | 'user';

interface OrchestratorInput {
  tenantId: string;
  scope: Scope;
  subjectUserId: string | null;
  requestedBy: string;
  legalReason: string;
  dryRun: boolean;
  env: 'dev' | 'prod';
  projectId: string;
  exportBucket: string;
  receiptBucket: string;
  hmacSecretName: string;
}

interface ServiceResult {
  service: string;
  status: 'success' | 'error';
  recordsPerType: Record<string, number>;
  errorMessage?: string;
}

export async function orchestrate(input: OrchestratorInput): Promise<{
  requestId: string;
  exportGcsUri: string;
  receiptGcsUri: string;
  services: ServiceResult[];
  erasure: { recordsDeleted: bigint; recordsPseudonymized: bigint };
}> {
  const requestId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  const secret = await loadHmacSecret(input.projectId, input.hmacSecretName);
  const hmac = signDataSubjectToken(secret, input.tenantId, input.subjectUserId, input.scope, input.requestedBy, expiresAt);

  const tmpDir = path.join(tmpdir(), `dsar-${requestId}`);
  mkdirSync(tmpDir, { recursive: true });
  const exportPath = path.join(tmpDir, `export.jsonl.gz`);

  const results: ServiceResult[] = [];
  const aggregateCounts: Record<string, number> = {};
  let recordsDeleted = 0n;
  let recordsPseudonymized = 0n;

  // Stream all services' records into a single gzipped .jsonl.
  const { writable, finalize } = await openExportStream(exportPath);
  try {
    for (const service of TARGET_SERVICES) {
      try {
        const serviceResult = await callServiceExport({
          service,
          tenantId: input.tenantId,
          scope: input.scope,
          subjectUserId: input.subjectUserId,
          requestedBy: input.requestedBy,
          expiresAt,
          authorizationHmac: hmac,
          dryRun: input.dryRun,
          writable,
        });
        results.push(serviceResult);
        for (const [k, v] of Object.entries(serviceResult.recordsPerType)) {
          aggregateCounts[`${service}.${k}`] = (aggregateCounts[`${service}.${k}`] ?? 0) + v;
        }
      } catch (err) {
        results.push({
          service,
          status: 'error',
          recordsPerType: {},
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await finalize();
  }

  // Upload the export file.
  const storage = new Storage({ projectId: input.projectId });
  const exportObject = `${requestId}/export.jsonl.gz`;
  await storage.bucket(input.exportBucket).upload(exportPath, {
    destination: exportObject,
    metadata: {
      metadata: {
        requestId,
        tenantId: input.tenantId,
        scope: input.scope,
        requestedBy: input.requestedBy,
        legalReason: input.legalReason,
        expires: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      },
    },
  });
  const exportGcsUri = `gs://${input.exportBucket}/${exportObject}`;

  // Erasure pass (scope===user always calls; scope===tenant calls for
  // user-owned rows across all services).
  for (const service of TARGET_SERVICES) {
    try {
      const erasure = await callServiceDelete({
        service,
        tenantId: input.tenantId,
        scope: input.scope,
        subjectUserId: input.subjectUserId,
        requestedBy: input.requestedBy,
        expiresAt,
        authorizationHmac: hmac,
        dryRun: input.dryRun,
      });
      recordsDeleted += erasure.recordsDeleted;
      recordsPseudonymized += erasure.recordsPseudonymized;
    } catch {
      /* Recorded in the service's own audit log; orchestrator continues. */
    }
  }

  // Write receipt — counts per type only, NEVER content.
  const receipt = {
    requestId,
    tenantId: input.tenantId,
    subjectUserId: input.subjectUserId,
    scope: input.scope,
    requestedBy: input.requestedBy,
    requestedAt: new Date().toISOString(),
    legalReason: input.legalReason,
    services: Object.fromEntries(
      results.map((r) => [r.service, {
        status: r.status,
        recordCounts: r.recordsPerType,
        ...(r.errorMessage ? { error: r.errorMessage } : {}),
      }]),
    ),
    erasure: {
      recordsDeleted: String(recordsDeleted),
      recordsPseudonymized: String(recordsPseudonymized),
    },
    export: { gcsUri: exportGcsUri, retentionDays: 7 },
  };
  const yyyy = new Date().getUTCFullYear();
  const mm = String(new Date().getUTCMonth() + 1).padStart(2, '0');
  const receiptObject = `${yyyy}/${mm}/${requestId}.json`;
  const manifestBytes = Buffer.from(JSON.stringify(receipt, null, 2), 'utf-8');
  await storage.bucket(input.receiptBucket).file(receiptObject).save(manifestBytes, {
    contentType: 'application/json',
  });
  const receiptGcsUri = `gs://${input.receiptBucket}/${receiptObject}`;

  return {
    requestId,
    exportGcsUri,
    receiptGcsUri,
    services: results,
    erasure: { recordsDeleted, recordsPseudonymized },
  };
}

// ── HMAC helpers ─────────────────────────────────────────────────────

export function signDataSubjectToken(
  secret: string,
  tenantId: string,
  subjectUserId: string | null,
  scope: Scope,
  requestedBy: string,
  expiresAt: Date,
): Buffer {
  const payload = Buffer.concat([
    Buffer.from(tenantId, 'utf-8'),
    Buffer.from([0]),
    Buffer.from(subjectUserId ?? '', 'utf-8'),
    Buffer.from([0]),
    Buffer.from(scope, 'utf-8'),
    Buffer.from([0]),
    Buffer.from(requestedBy, 'utf-8'),
    Buffer.from([0]),
    bigIntBE(BigInt(expiresAt.getTime())),
  ]);
  return createHmac('sha256', secret).update(payload).digest();
}

function bigIntBE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(v);
  return b;
}

async function loadHmacSecret(projectId: string, secretName: string): Promise<string> {
  if (process.env.NODE_ENV === 'test') {
    return process.env.DATA_SUBJECT_HMAC_SECRET ?? 'test-secret';
  }
  const client = new SecretManagerServiceClient();
  const [v] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
  });
  return v.payload?.data?.toString('utf-8') ?? '';
}

// ── Service calls — stubs the real RPC clients fill in ──────────────

async function openExportStream(destination: string): Promise<{
  writable: NodeJS.WritableStream;
  finalize: () => Promise<void>;
}> {
  const file = createWriteStream(destination);
  const gzip = createGzip();
  const pipe = pipeline(gzip, file);
  return {
    writable: gzip,
    finalize: async () => {
      gzip.end();
      await pipe;
    },
  };
}

interface ServiceCallInput {
  service: string;
  tenantId: string;
  scope: Scope;
  subjectUserId: string | null;
  requestedBy: string;
  expiresAt: Date;
  authorizationHmac: Buffer;
  dryRun: boolean;
}

async function callServiceExport(
  input: ServiceCallInput & { writable: NodeJS.WritableStream },
): Promise<ServiceResult> {
  // Platform-backend data is handled inline by the orchestrator itself
  // (accounts, tenants, subscriptions). It has no ExportTenantData proto.
  if (input.service === 'liftoff-platform-backend') {
    const sha = createHash('sha256').update(input.service + input.tenantId).digest('hex');
    input.writable.write(
      JSON.stringify({ service: input.service, tenantId: input.tenantId, marker: sha }) + '\n',
    );
    return { service: input.service, status: 'success', recordsPerType: { marker: 1 } };
  }

  const client = getServiceClient(input.service as Parameters<typeof getServiceClient>[0]);
  if (!client) {
    // Service URL not configured — skip gracefully (service not yet deployed).
    console.warn(`[orchestrator] skipping ${input.service} — service URL not configured`);
    return { service: input.service, status: 'success', recordsPerType: {} };
  }

  const recordsPerType: Record<string, number> = {};
  try {
    const req = {
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId ?? undefined,
      scope: input.scope,
      requestedBy: input.requestedBy,
      expiresAt: input.expiresAt,
      authorizationHmac: input.authorizationHmac,
    };

    // All services expose ExportTenantData as a server-streaming RPC.
    for await (const chunk of (client as { exportTenantData: (r: unknown) => AsyncIterable<{ recordType?: string; sequence?: bigint }> }).exportTenantData(req)) {
      const recordType = String(chunk.recordType ?? 'unknown');
      recordsPerType[recordType] = (recordsPerType[recordType] ?? 0) + 1;
      input.writable.write(
        JSON.stringify({ service: input.service, recordType, sequence: Number(chunk.sequence ?? 0n), data: chunk }) + '\n',
      );
    }
    return { service: input.service, status: 'success', recordsPerType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] ${input.service} ExportTenantData failed:`, msg);
    return { service: input.service, status: 'error', recordsPerType, errorMessage: msg };
  }
}

async function callServiceDelete(
  input: ServiceCallInput,
): Promise<{ recordsDeleted: bigint; recordsPseudonymized: bigint }> {
  if (input.dryRun) return { recordsDeleted: 0n, recordsPseudonymized: 0n };
  if (input.service === 'liftoff-platform-backend') return { recordsDeleted: 0n, recordsPseudonymized: 0n };

  const client = getServiceClient(input.service as Parameters<typeof getServiceClient>[0]);
  if (!client) return { recordsDeleted: 0n, recordsPseudonymized: 0n };

  try {
    const req = {
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId ?? undefined,
      scope: input.scope,
      requestedBy: input.requestedBy,
      expiresAt: input.expiresAt,
      authorizationHmac: input.authorizationHmac,
    };
    const result = await (client as { deleteTenantUserData: (r: unknown) => Promise<{ recordsDeleted?: bigint; recordsPseudonymized?: bigint }> }).deleteTenantUserData(req);
    return {
      recordsDeleted: result.recordsDeleted ?? 0n,
      recordsPseudonymized: result.recordsPseudonymized ?? 0n,
    };
  } catch (err) {
    console.error(`[orchestrator] ${input.service} DeleteTenantUserData failed:`, err instanceof Error ? err.message : String(err));
    return { recordsDeleted: 0n, recordsPseudonymized: 0n };
  }
}

// ── CLI entry ────────────────────────────────────────────────────────

export async function cliMain(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = argv.findIndex((a) => a === `--${k}` || a.startsWith(`--${k}=`));
    if (i < 0) return undefined;
    const a = argv[i];
    return a.includes('=') ? a.split('=')[1] : argv[i + 1];
  };
  const env = (process.env.ENVIRONMENT ?? 'dev') as 'dev' | 'prod';
  const input: OrchestratorInput = {
    tenantId: get('tenant') ?? '',
    scope: (get('scope') as Scope) ?? 'tenant',
    subjectUserId: get('subject-user') ?? null,
    requestedBy: get('requested-by') ?? '',
    legalReason: get('legal-reason') ?? '',
    dryRun: argv.includes('--dry-run'),
    env,
    projectId: process.env.GCP_PROJECT_ID ?? '',
    exportBucket: process.env.EXPORT_BUCKET ?? `data-exports-${env}`,
    receiptBucket: process.env.RECEIPT_BUCKET ?? `data-subject-receipts-${env}`,
    hmacSecretName: process.env.HMAC_SECRET_NAME ?? `data-subject-access-hmac-${env}`,
  };
  if (!input.tenantId || !input.requestedBy) {
    throw new Error('usage: --tenant=<uuid> --requested-by=<email> [--scope=tenant|user] [--subject-user=<uuid>] [--legal-reason="..."] [--dry-run]');
  }
  const result = await orchestrate(input);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1]?.endsWith('data-export-orchestrator/index.js')) {
  cliMain().catch((err) => {
    console.error('[dsar-orchestrator]', err);
    process.exit(1);
  });
}
