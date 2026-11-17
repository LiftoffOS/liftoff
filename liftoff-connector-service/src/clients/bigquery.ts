// BigQuery native client — implementation plan §3C + §5.
//
// Read-first, keyless. Auth: the Cloud Run runtime SA (ADC) impersonates a
// per-tenant service account (connectorConfig.serviceAccountEmail); the
// customer grants that SA `bigquery.dataViewer` + `bigquery.jobUser` on their
// project (plan §5). No service-account keys are stored.
//
// Functions (read surface; write/DDL are a gated follow-on per plan §1.3/§14):
//   list_dataset_ids, list_table_ids, get_table_schema, run_query.
// The read-only statement gate + row-cap wrap are enforced CENTRALLY in
// execute-dispatcher via fn.sqlGuard (plan §2); run_query here additionally
// sets the BigQuery cost ceiling (maximumBytesBilled) + result cap and records
// the per-query audit metadata.

import { GoogleAuth, Impersonated } from 'google-auth-library';
import type { JsonObject } from '@bufbuild/protobuf';
import { registerConnectorExecutor, type ExecutorContext, type ExecutorResult } from '../rpc/execute-dispatcher.js';
import { logger } from '../infra/logging.js';
import { DEFAULT_GUARDRAILS, type QueryAuditRecord } from './warehouse/query-guardrails.js';

const BQ_SCOPE = 'https://www.googleapis.com/auth/bigquery';
// The SOURCE credential (runtime SA) must be able to call IAMCredentials
// generateAccessToken to impersonate the per-tenant SA — that requires the
// cloud-platform scope, NOT the bigquery scope. (A bigquery-only source token
// yields "insufficient authentication scopes" on the impersonation call —
// caught by the dev BigQuery E2E.) The IMPERSONATED token is bigquery-scoped
// (targetScopes below), which is correct for the BQ REST calls.
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2';
/** Default cost ceiling per query (plan §2). Tunable per connector later. */
const BQ_MAX_BYTES_BILLED = 10 * 1024 ** 3; // 10 GiB

let sharedAuth: GoogleAuth | null = null;
function getSourceAuth(): GoogleAuth {
  if (!sharedAuth) sharedAuth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  return sharedAuth;
}

/** Mint a short-lived BigQuery access token by impersonating the per-tenant SA. */
async function getImpersonatedToken(targetPrincipal: string): Promise<string> {
  const sourceClient = await getSourceAuth().getClient();
  const impersonated = new Impersonated({
    sourceClient,
    targetPrincipal,
    targetScopes: [BQ_SCOPE],
    lifetime: 3600,
  });
  const { token } = await impersonated.getAccessToken();
  if (!token) throw new Error('bigquery_impersonation_failed: empty access token');
  return token;
}

interface BqConfig {
  projectId: string;
  serviceAccountEmail: string;
  dataset?: string;
}

function readConfig(cfg: Record<string, unknown>): BqConfig {
  const projectId = cfg.projectId as string | undefined;
  const serviceAccountEmail = cfg.serviceAccountEmail as string | undefined;
  if (!projectId) throw new Error('bigquery connector requires connectorConfig.projectId');
  if (!serviceAccountEmail) {
    throw new Error(
      'bigquery connector requires connectorConfig.serviceAccountEmail (the per-tenant SA the customer granted BigQuery access to)',
    );
  }
  return { projectId, serviceAccountEmail, dataset: cfg.dataset as string | undefined };
}

interface BqError { error?: { message?: string } }
interface BqDatasetList { datasets?: Array<{ datasetReference?: { datasetId?: string } }> }
interface BqTableList { tables?: Array<{ tableReference?: { tableId?: string } }> }
interface BqField { name?: string; type?: string; mode?: string }
interface BqTable { schema?: { fields?: BqField[] } }
interface BqQueryResponse {
  schema?: { fields?: BqField[] };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  totalRows?: string;
  totalBytesProcessed?: string;
}

async function bqFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BQ_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & BqError;
  if (!res.ok) {
    const msg = body?.error?.message ?? res.statusText;
    const err = new Error(`bigquery_api_error ${res.status}: ${msg}`) as Error & { httpStatus?: number };
    err.httpStatus = res.status;
    throw err;
  }
  return body;
}

export const bigQueryExecutor = async (ctx: ExecutorContext): Promise<ExecutorResult> => {
  const cfg = readConfig(ctx.connectorConfig);
  const token = await getImpersonatedToken(cfg.serviceAccountEmail);
  const input = ctx.input as Record<string, unknown>;
  const started = Date.now();

  switch (ctx.functionName) {
    case 'list_dataset_ids': {
      const body = await bqFetch<BqDatasetList>(token, `/projects/${cfg.projectId}/datasets?maxResults=1000`);
      const datasets = (body.datasets ?? [])
        .map((d) => d.datasetReference?.datasetId)
        .filter((x): x is string => Boolean(x));
      return { result: { datasets } as JsonObject, vendorLatencyMs: Date.now() - started };
    }

    case 'list_table_ids': {
      const datasetId = (input.datasetId ?? cfg.dataset) as string | undefined;
      if (!datasetId) throw new Error('list_table_ids requires a datasetId');
      const body = await bqFetch<BqTableList>(
        token,
        `/projects/${cfg.projectId}/datasets/${datasetId}/tables?maxResults=1000`,
      );
      const tables = (body.tables ?? [])
        .map((t) => t.tableReference?.tableId)
        .filter((x): x is string => Boolean(x));
      return { result: { datasetId, tables } as JsonObject, vendorLatencyMs: Date.now() - started };
    }

    case 'get_table_schema': {
      const datasetId = (input.datasetId ?? cfg.dataset) as string | undefined;
      const tableId = input.tableId as string | undefined;
      if (!datasetId || !tableId) throw new Error('get_table_schema requires datasetId and tableId');
      const body = await bqFetch<BqTable>(
        token,
        `/projects/${cfg.projectId}/datasets/${datasetId}/tables/${tableId}`,
      );
      const fields = (body.schema?.fields ?? []).map((f) => ({ name: f.name, type: f.type, mode: f.mode }));
      return { result: { datasetId, tableId, fields } as JsonObject, vendorLatencyMs: Date.now() - started };
    }

    case 'run_query': {
      // The read-only gate + row-cap wrap were already applied centrally in
      // execute-dispatcher via fn.sqlGuard (plan §2). Here we add the BigQuery
      // cost ceiling + result cap and record the audit metadata.
      const query = input.query as string;
      const body = await bqFetch<BqQueryResponse>(token, `/projects/${cfg.projectId}/queries`, {
        method: 'POST',
        body: JSON.stringify({
          query,
          useLegacySql: false,
          maximumBytesBilled: String(BQ_MAX_BYTES_BILLED),
          timeoutMs: DEFAULT_GUARDRAILS.timeoutMs,
          maxResults: DEFAULT_GUARDRAILS.maxRows,
        }),
      });
      const fieldNames = (body.schema?.fields ?? []).map((f) => f.name ?? '');
      const rows = (body.rows ?? []).map((r) => {
        const obj: Record<string, unknown> = {};
        (r.f ?? []).forEach((cell, i) => {
          obj[fieldNames[i] || `col_${i}`] = cell.v;
        });
        return obj;
      });
      const totalRows = body.totalRows ? Number(body.totalRows) : rows.length;
      const audit: QueryAuditRecord = {
        connector: 'google_bigquery',
        tenantId: ctx.tenantId,
        statement: query,
        rowCount: rows.length,
        bytesScanned: body.totalBytesProcessed ? Number(body.totalBytesProcessed) : undefined,
        truncated: totalRows > rows.length,
        ts: new Date().toISOString(),
      };
      // TODO(plan §2): route through agent-audit-logs once the hook point is
      // confirmed; structured log for now so every query is auditable.
      logger.info({ audit }, 'bigquery_query_audit');
      return {
        result: {
          fields: fieldNames,
          rows: rows as unknown as JsonObject[],
          totalRows,
          bytesProcessed: body.totalBytesProcessed ?? null,
          truncated: audit.truncated ?? false,
        } as JsonObject,
        vendorLatencyMs: Date.now() - started,
      };
    }

    case 'run_write_sql': {
      // Write/DDL (plan §14) — gated upstream by categories:['write']. No
      // read-only gate; still cost-capped via maximumBytesBilled.
      const statement = input.statement as string;
      if (!statement || typeof statement !== 'string') {
        throw new Error('run_write_sql requires a statement');
      }
      const body = await bqFetch<BqQueryResponse>(token, `/projects/${cfg.projectId}/queries`, {
        method: 'POST',
        body: JSON.stringify({
          query: statement,
          useLegacySql: false,
          maximumBytesBilled: String(BQ_MAX_BYTES_BILLED),
          timeoutMs: DEFAULT_GUARDRAILS.timeoutMs,
        }),
      });
      const audit: QueryAuditRecord = {
        connector: 'google_bigquery',
        tenantId: ctx.tenantId,
        statement,
        rowCount: body.totalRows ? Number(body.totalRows) : 0,
        bytesScanned: body.totalBytesProcessed ? Number(body.totalBytesProcessed) : undefined,
        ts: new Date().toISOString(),
      };
      logger.info({ audit }, 'bigquery_write_audit');
      return {
        result: {
          affectedRows: body.totalRows ? Number(body.totalRows) : null,
          bytesProcessed: body.totalBytesProcessed ?? null,
        } as JsonObject,
        vendorLatencyMs: Date.now() - started,
      };
    }

    default:
      throw new Error(`bigquery: unsupported function "${ctx.functionName}"`);
  }
};

registerConnectorExecutor('google_bigquery', bigQueryExecutor);
