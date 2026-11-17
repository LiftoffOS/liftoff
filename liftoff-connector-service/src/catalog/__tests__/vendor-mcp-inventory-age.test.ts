// Vendor-MCP inventory refresh-cadence gate.
//
// src/catalog/vendor-mcp-inventory/<type>.json is the public tool inventory a
// vendor-hosted connector's HITL seed was classified from, captured with no
// account, key or token (scripts/harvest-vendor-mcp-inventory.ts). A vendor's
// tool surface changes on the order of months, and a seed classified against a
// list the vendor has since changed is a seed that gates the wrong tools.
//
// Same rule and cadence as the response-shape fixtures
// (contract-tests/response-shapes/fixture-age-test.test.ts): every inventory
// must have been harvested within the last 120 days. CI fails on day 121
// unless an operator re-runs the harvester (which rewrites `harvestedAt`).
// Dated by the record's own `harvestedAt`, not the file's mtime, because a
// checkout does not preserve mtimes.
//
// The second block checks the shape the classifier reads, so a hand-edited
// or half-written inventory cannot seed anything.

import * as fs from 'fs';
import * as path from 'path';
import { CONNECTORS } from '../connectors';

const INVENTORY_DIR = path.resolve(__dirname, '..', 'vendor-mcp-inventory');
const MAX_INVENTORY_AGE_MS = 120 * 24 * 60 * 60 * 1000;
const SOURCES = new Set(['live_unauthenticated', 'vendor_docs', 'vendor_oss', 'vendor_api_reference', 'oauth_scopes']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

interface Inventory {
  connectorType: string;
  harvestedAt: string;
  source: string;
  sourceUrl: string;
  operationKey?: { tool: string; arg: string };
  tools: Array<{ name: string; description: string; annotations?: Record<string, unknown>; httpMethod?: string; path?: string }>;
}

function loadInventories(): Array<{ file: string; inventory: Inventory }> {
  return fs.readdirSync(INVENTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      file: f,
      inventory: JSON.parse(fs.readFileSync(path.join(INVENTORY_DIR, f), 'utf-8')) as Inventory,
    }));
}

describe('vendor-MCP inventory refresh-cadence gate', () => {
  const inventories = loadInventories();

  it('has at least one inventory (catches accidental directory deletion)', () => {
    expect(inventories.length).toBeGreaterThan(0);
  });

  it.each(inventories.map((i) => [i.file, i] as const))(
    '%s was harvested within the last 120 days',
    (_file, { file, inventory }) => {
      const harvested = Date.parse(inventory.harvestedAt);
      expect(Number.isNaN(harvested)).toBe(false);
      const ageMs = Date.now() - harvested;
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      if (ageMs > MAX_INVENTORY_AGE_MS) {
        throw new Error(
          `inventory ${file} was harvested ${days} days ago (max 120). ` +
          `Re-run: npm run harvest:vendor-mcp -- --connector ${inventory.connectorType} ` +
          `--source <live|docs|oss|api-reference> [--url ${inventory.sourceUrl}], then re-seed ` +
          'with classify:tools --from-inventory.',
        );
      }
      expect(days).toBeLessThanOrEqual(120);
    },
  );
});

describe('vendor-MCP inventory shape', () => {
  const inventories = loadInventories();

  it.each(inventories.map((i) => [i.file, i] as const))(
    '%s is a complete record the classifier can read',
    (_file, { file, inventory }) => {
      // The file name IS the connector type, and the type is a catalog entry.
      expect(`${inventory.connectorType}.json`).toBe(file);
      expect(CONNECTORS[inventory.connectorType]).toBeDefined();
      expect(SOURCES.has(inventory.source)).toBe(true);
      expect(inventory.sourceUrl).toMatch(/^https?:\/\//);
      expect(inventory.tools.length).toBeGreaterThan(0);

      const names = new Set<string>();
      for (const tool of inventory.tools) {
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
        expect(names.has(tool.name)).toBe(false);
        names.add(tool.name);
        expect(typeof tool.description).toBe('string');
        if (tool.httpMethod !== undefined) expect(METHODS.has(tool.httpMethod)).toBe(true);
        if (tool.annotations !== undefined) {
          for (const v of Object.values(tool.annotations)) expect(typeof v).toBe('boolean');
        }
      }

      // A meta-tool server names the operation argument, and its inventory
      // carries the expanded `<tool>:<operation>` rows the seed is keyed by.
      if (inventory.operationKey) {
        const { tool, arg } = inventory.operationKey;
        expect(tool.length).toBeGreaterThan(0);
        expect(arg.length).toBeGreaterThan(0);
        expect(inventory.tools.some((t) => t.name.startsWith(`${tool}:`))).toBe(true);
      }
    },
  );
});
