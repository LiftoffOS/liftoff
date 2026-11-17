// Propose `idArgs` for every undeclared write, into the reviewed file.
//
//   npm run propose:id-args
//
// Reads the registry, runs the declaration generator over every connector, and
// ADDS what it proposes to src/catalog/generated/reviewed-id-args.json. The
// diff of that file is the review. Two rules keep the review meaningful:
//
//   - A function already in the file is left exactly as it is. A reviewer who
//     narrowed `['invoice_id', 'invoice_number']` to `['invoice_id']` must not
//     find the second name back on the next run.
//   - A function under `rejected` is never proposed again.
//
// A function whose hand-written `idArgs` exists in the registry is not proposed
// at all — the generator skips it — so the file only ever covers what nobody
// declared. Run it after adding a connector or a write; the ratchet in
// src/catalog/__tests__/declaration-coverage-ratchet.test.ts then expects the
// connector to come off the undeclared baseline.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRegisteredConnectorTypes, getConnectorFunctions } from '../src/catalog/connector-functions-registry.js';
import { generateIdArgDeclarations } from '../src/catalog/declaration-generator.js';
import type { ReviewedIdArgsFile } from '../src/catalog/reviewed-id-args.js';

const PATH = join(__dirname, '..', 'src', 'catalog', 'generated', 'reviewed-id-args.json');

const file: ReviewedIdArgsFile = existsSync(PATH)
  ? (JSON.parse(readFileSync(PATH, 'utf8')) as ReviewedIdArgsFile)
  : { declarations: {} };
file.declarations ??= {};

let added = 0;
let kept = 0;
let skipped = 0;
for (const type of getRegisteredConnectorTypes().sort()) {
  const rejected = new Set(file.rejected?.[type] ?? []);
  // The registry already applies the file, so a function it covers carries
  // `idArgs` and the generator does not propose it again. What comes back is
  // exactly what is neither hand-written nor reviewed.
  for (const decl of generateIdArgDeclarations(type, getConnectorFunctions(type))) {
    if (rejected.has(decl.functionName)) { skipped += 1; continue; }
    const forType = (file.declarations[type] ??= {});
    if (decl.functionName in forType) { kept += 1; continue; }
    forType[decl.functionName] = decl.idArgs;
    added += 1;
  }
  if (file.declarations[type] && Object.keys(file.declarations[type]).length === 0) delete file.declarations[type];
}

// Stable order, so the diff is the change and not the shuffle.
const ordered: ReviewedIdArgsFile = {
  declarations: Object.fromEntries(
    Object.keys(file.declarations).sort().map((type) => [
      type,
      Object.fromEntries(Object.keys(file.declarations[type]).sort().map((fn) => [fn, file.declarations[type][fn]])),
    ]),
  ),
  ...(file.rejected ? { rejected: file.rejected } : {}),
};
writeFileSync(PATH, `${JSON.stringify(ordered, null, 2)}\n`);

const total = Object.values(ordered.declarations).reduce((n, fns) => n + Object.keys(fns).length, 0);
console.error(`propose-id-args: ${added} added, ${kept} already reviewed, ${skipped} rejected; ${total} declarations across ${Object.keys(ordered.declarations).length} connectors → ${PATH}`);
