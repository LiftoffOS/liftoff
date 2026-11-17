#!/usr/bin/env node
// CLI: turn a vendor API spec into the exhaustive first-class tool set for a native
// HRIS connector — ONE ConnectorFunction per documented operation. The generation
// logic lives in src/catalog/spec-codegen.ts (pure, typechecked, unit-tested); this
// file only does arg parsing + file I/O.
//
// Usage:
//   npm run gen:connector-tools -- --connector gusto --openapi ./specs/gusto.json
//   npm run gen:connector-tools -- --connector oracle_hcm --openapi ./specs/oracle.json --lean-schema
//   npm run gen:connector-tools -- --connector sap_successfactors --odata ./specs/sf-metadata.xml
//
// Options: --strip-prefix <p> (drop a base path the client already carries),
//          --path-prefix <p>  (prepend a module base, e.g. Workday module),
//          --lean-schema      (minimal per-op schema for very large specs).
//
// Emits src/catalog/generated/<connector>.generated.json — a JSON array of
// ConnectorFunction objects, DATA (not tsc/eslint/jest-processed) read at runtime by
// native-hris-functions.ts. Shape is validated at emit time (spec-codegen validateOps).
// + a companion <connector>-classification.json for the platform-backend migration.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fromOpenApi, fromODataMetadata, fromWsdl, dedupeNames, emitJson, classificationRows, GenOp } from '../src/catalog/spec-codegen';

type Json = Record<string, unknown>;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const connector = arg('--connector');
  const openapiPath = arg('--openapi');
  const odataPath = arg('--odata');
  const wsdlDir = arg('--wsdl-dir');
  if (!connector || (!openapiPath && !odataPath && !wsdlDir)) {
    console.error('usage: gen-connector-tools --connector <type> (--openapi <spec> | --odata <metadata.xml> | --wsdl-dir <dir/*.wsdl>)');
    process.exit(1);
  }
  const loadSpec = (p: string): Json => {
    const txt = readFileSync(p, 'utf8');
    if (/\.ya?ml$/i.test(p)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('js-yaml').load(txt) as Json;
    }
    return JSON.parse(txt) as Json;
  };
  const lean = process.argv.includes('--lean-schema');
  let ops: GenOp[];
  if (wsdlDir) {
    // Each .wsdl in the dir is one WWS service; service name = file basename.
    ops = [];
    for (const f of readdirSync(wsdlDir).filter((n) => /\.wsdl$/i.test(n)).sort()) {
      const service = f.replace(/\.wsdl$/i, '');
      const svcOps = fromWsdl(readFileSync(join(wsdlDir, f), 'utf8'), service);
      console.error(`  ${service}: ${svcOps.length} WWS operations`);
      ops.push(...svcOps);
    }
  } else if (openapiPath) {
    ops = fromOpenApi(loadSpec(openapiPath), arg('--strip-prefix'), arg('--path-prefix'), lean);
  } else {
    ops = fromODataMetadata(readFileSync(odataPath!, 'utf8'));
  }
  // Long vendor descriptions dominate the emitted file on huge specs; cap them.
  if (lean) for (const o of ops) if (o.description.length > 140) o.description = o.description.slice(0, 137) + '…';
  // Namespace names by module (e.g. Workday REST person/staffing/performance) so
  // distinct endpoints that share an operationId across modules don't collide when
  // the module tool sets merge into one connector.
  const namePrefix = arg('--name-prefix');
  if (namePrefix) for (const o of ops) o.name = `${namePrefix}_${o.name}`;
  // Names are the registry key — guarantee uniqueness so no distinct endpoint is
  // dropped when the tool sets merge (vendors reuse operationId across resources).
  dedupeNames(ops);

  mkdirSync('src/catalog/generated', { recursive: true });
  // Tool sets ship as JSON DATA (loaded at runtime, not tsc/eslint/jest-processed).
  const outTs = `src/catalog/generated/${connector}.generated.json`;
  writeFileSync(outTs, emitJson(ops));
  const classification = classificationRows(ops);
  writeFileSync(`src/catalog/generated/${connector}-classification.json`, JSON.stringify(classification, null, 2));
  const src = wsdlDir ?? openapiPath ?? odataPath!;
  console.error(`${connector}: ${ops.length} endpoints → ${outTs} (+ ${classification.length} classification rows) [source: ${basename(src)}]`);
}

main();
