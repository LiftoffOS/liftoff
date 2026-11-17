// Manual: pull captured first-real-response samples out of connector_response_samples and write
// them as fixtures under src/contract-tests/response-shapes/__fixtures__/<connector>/<action>.json
// for a human to review + commit. Run via a one-shot Cloud Run Job with DB access (see CLAUDE.md).
//   ts-node scripts/pull-response-samples.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAdminPool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const pool = await getAdminPool();
  const { rows } = await pool.query<{ connector_type: string; function_name: string; sample: unknown }>(
    'SELECT connector_type, function_name, sample FROM connector_response_samples ORDER BY connector_type, function_name',
  );
  const base = resolve(__dirname, '..', 'src', 'contract-tests', 'response-shapes', '__fixtures__');
  for (const r of rows) {
    const dir = resolve(base, r.connector_type);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${r.function_name}.json`), JSON.stringify(r.sample, null, 2) + '\n');
    console.error(`wrote ${r.connector_type}/${r.function_name}.json`);
  }
  console.error(`pulled ${rows.length} sample(s)`);
}

void main();
