#!/usr/bin/env node
// Fixture capture utility (manual run only — never in CI).
//
// Refreshes a fixture by issuing a real call against a staging tenant's
// bound connector and writing the response (after PII redaction) to
// __fixtures__/<connector_type>/<action>.json.
//
// Usage:
//   npx ts-node src/contract-tests/response-shapes/__tools__/capture-fixtures.ts \
//     --action=<action> --connector=<connector_type> --tenant=<staging-tenant-uuid>
//
// Required env:
//   CONNECTOR_SERVICE_URL — base URL of the staging connector-service
//   ID_TOKEN              — short-lived ID token for the runner SA
//                           (gcloud auth print-identity-token --audiences=$CONNECTOR_SERVICE_URL)
//
// Redaction: emails / phones / SSNs / JWT-shaped tokens / Bearer headers /
// AWS keys are stripped via @liftoffos/proto-gen redactPii before write.
// Inspect the diff before committing — the scrubber is best-effort.

import * as fs from 'fs';
import * as path from 'path';
import { redactPii } from '@liftoffos/proto-gen/dist/redaction.js';

interface Args { action: string; connector: string; tenant: string; }

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.+)$/i.exec(a);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'action') out.action = val;
    if (key === 'connector') out.connector = val;
    if (key === 'tenant') out.tenant = val;
  }
  if (!out.action || !out.connector || !out.tenant) {
    console.error('usage: capture-fixtures --action=<a> --connector=<c> --tenant=<uuid>');
    process.exit(2);
  }
  return out as Args;
}

function deepRedact(value: unknown): unknown {
  if (typeof value === 'string') return redactPii(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRedact(v);
    }
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.CONNECTOR_SERVICE_URL;
  const idToken = process.env.ID_TOKEN;
  if (!baseUrl || !idToken) {
    console.error('CONNECTOR_SERVICE_URL and ID_TOKEN env vars are required');
    process.exit(2);
  }

  const reqBody = {
    tenantContext: { tenantId: args.tenant },
    connectorType: args.connector,
    functionName: args.action,
    input: {},
    idempotencyKey: `capture-fixtures-${Date.now()}`,
  };

  const url = `${baseUrl}/liftoff.connector.v1.ConnectorService/Execute`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Execute failed: ${res.status} ${text}`);
    process.exit(1);
  }

  const body = await res.json() as { result?: unknown; data?: unknown };
  const payload = body.result ?? body.data ?? body;
  const redacted = deepRedact(payload);

  const outDir = path.resolve(__dirname, '..', '__fixtures__', args.connector);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${args.action}.json`);
  fs.writeFileSync(outFile, JSON.stringify(redacted, null, 2) + '\n');
  console.log(`captured ${outFile}`);
}

void main();
