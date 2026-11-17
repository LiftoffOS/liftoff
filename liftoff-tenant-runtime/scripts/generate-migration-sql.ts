#!/usr/bin/env npx tsx
// Generates migration SQL from the connector functions registry.
// Output goes to stdout — pipe to a file or paste into a migration.

import { getConnectorFunctions, getRegisteredConnectorTypes } from '../src/connectors/connector-functions-registry';

console.log(`-- Migration 040: Seed connector manifest functions for all OAuth connectors
-- Auto-generated from connector-functions-registry.ts
-- Safe to re-run: only updates manifests with empty functions arrays.
`);

for (const connectorType of getRegisteredConnectorTypes()) {
  const functions = getConnectorFunctions(connectorType);
  if (functions.length === 0) continue;

  const json = JSON.stringify(functions).replace(/'/g, "''");
  console.log(`-- ${connectorType} (${functions.length} functions)`);
  console.log(`UPDATE connector_manifests`);
  console.log(`SET functions = '${json}'::jsonb, updated_at = NOW()`);
  console.log(`WHERE connector_type = '${connectorType}' AND functions = '[]'::jsonb;\n`);
}
