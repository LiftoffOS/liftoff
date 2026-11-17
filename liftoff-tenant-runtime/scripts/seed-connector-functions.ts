#!/usr/bin/env npx tsx
// Seed connector manifest functions for all existing connectors.
// Sources function definitions from the connector-functions-registry.
//
// Usage:
//   DATABASE_URL=postgres://... npx tsx scripts/seed-connector-functions.ts
//
// Safe to run multiple times — only updates manifests with empty functions.

import { Pool } from 'pg';
import { getConnectorFunctions, getRegisteredConnectorTypes } from '../src/connectors/connector-functions-registry';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const connectorTypes = getRegisteredConnectorTypes();
    let updated = 0;

    for (const connectorType of connectorTypes) {
      const functions = getConnectorFunctions(connectorType);
      if (functions.length === 0) continue;

      const result = await pool.query(
        `UPDATE connector_manifests
         SET functions = $1::jsonb, updated_at = NOW()
         WHERE connector_type = $2
           AND functions = '[]'::jsonb`,
        [JSON.stringify(functions), connectorType]
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`  ✓ ${connectorType}: updated ${result.rowCount} manifest(s) with ${functions.length} functions`);
        updated += result.rowCount;
      }
    }

    if (updated === 0) {
      console.log('  No empty manifests to update — all already populated.');
    } else {
      console.log(`\nDone. Updated ${updated} manifest(s) across ${connectorTypes.length} connector types.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to seed connector functions:', err);
  process.exit(1);
});
