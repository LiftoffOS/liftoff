#!/usr/bin/env node
// Drift probe: run detect + inventory against the newest harvested generation.
//
// Answers one question — can this adapter still read a fresh installation of
// upstream latest? The pinned-fixture tests cannot answer it: they pass by
// construction against a snapshot that stopped changing, which is exactly the
// blind spot that lets an adapter rot while CI stays green.
//
// Exits non-zero on a parse failure, on zero identities found (a strong signal
// the layout moved), or on new unrecognised configuration fields.

'use strict';

const fs = require('fs');
const path = require('path');

async function main() {
  const source = process.argv[2];
  if (source !== 'openclaw' && source !== 'hermes') {
    console.error('usage: probe-latest.js <openclaw|hermes>');
    process.exit(2);
  }

  const generationDir = path.join(__dirname, 'fixtures', source, 'latest');
  if (!fs.existsSync(generationDir)) {
    console.error(`No harvested generation at ${generationDir}. The harvest step must run first.`);
    process.exit(1);
  }

  // The built CLI, not the source: the probe should exercise what ships.
  const distRoot = path.join(__dirname, '..', '..', 'packages', 'liftoff-cli', 'dist', 'switch', 'sources');
  const mod = require(path.join(distRoot, `${source}.js`));
  const factory = source === 'openclaw' ? mod.openclawAdapter : mod.hermesAdapter;

  const roots = [path.join(generationDir, 'clean'), path.join(generationDir, 'dirty')].filter((p) =>
    fs.existsSync(p),
  );
  if (roots.length === 0) {
    console.error('Harvested generation contains neither a clean nor a dirty snapshot.');
    process.exit(1);
  }

  let failures = 0;

  for (const root of roots) {
    const label = path.basename(root);
    console.log(`\n=== ${source} / ${label} ===`);

    const adapter = factory({ path: root });

    let installations;
    try {
      installations = await adapter.detect();
    } catch (err) {
      console.error(`detect threw: ${err.message}`);
      failures += 1;
      continue;
    }

    if (installations.length === 0) {
      console.error('detect found nothing — the installation layout has probably moved.');
      failures += 1;
      continue;
    }
    console.log(`detect: ${installations.length} installation(s), version=${installations[0].sourceVersion ?? 'unknown'}`);

    let inventory;
    try {
      inventory = await adapter.inventory(installations[0]);
    } catch (err) {
      console.error(`inventory threw: ${err.message}`);
      failures += 1;
      continue;
    }

    console.log(
      `inventory: ${inventory.identities.length} identities, ` +
        `${inventory.mcpServers.length} MCP servers, ${inventory.routines.length} routines`,
    );

    if (inventory.identities.length === 0) {
      console.error('inventory found no identities — layout drift is likely.');
      failures += 1;
    }

    // New unrecognised configuration fields are the earliest visible sign that
    // upstream added something we do not model yet.
    const unknown = inventory.unsupportedItems.filter(
      (u) => u.reason === 'unknown_configuration_field',
    );
    if (unknown.length > 0) {
      console.log(`\nUnrecognised configuration fields (${unknown.length}):`);
      for (const u of unknown) console.log(`  - ${u.sourceRef}`);
      // Informational rather than fatal on its own: a new optional field is
      // normal. It becomes actionable when it accompanies a drop in what we
      // could read, which the checks above catch.
    }

    try {
      const bundle = await adapter.normalize(inventory);
      console.log(`normalize: ${bundle.agents.length} agents, ${bundle.unsupportedItems.length} unsupported`);
    } catch (err) {
      console.error(`normalize threw: ${err.message}`);
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} probe failure(s) against upstream latest.`);
    process.exit(1);
  }
  console.log('\nProbe clean: the adapter still reads a fresh installation of upstream latest.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
