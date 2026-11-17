// FITNESS FUNCTION — every connector a customer can BIND must be answerable
// as a type that exists.
//
// Platform-backend reads /api/connectors/catalog/connector-types as an
// EXISTENCE allow-list when writing internal_agents.integrations. A type
// missing from this response is not treated as "no native tools", it is treated
// as a type that does not exist — and the write is refused. Because that write
// path re-validates the WHOLE integrations array on every save, one absent type
// blocks every save of every team bound to it: bindings, prose, skills, model.
//
// The trap is that the absence is a NORMAL consequence of a connector moving to
// an MCP server. Its tools stop living in CONNECTOR_FUNCTIONS and start being
// discovered from the server at run time, so an endpoint enumerating the
// function registry drops it silently, on a deploy that looks like a refactor.
// GitHub did exactly that in Phase 3.1 and the breakage surfaced as "failed to
// save changes" in the team editor, with nothing logged on either side.

import express from 'express';
import request from 'supertest';
import { catalogRouter, type ConnectorTypeEntry } from '../router.js';
import { getConnectorCatalog } from '../projections.js';
import { getRegisteredConnectorTypes } from '../connector-functions-registry.js';

type TypeEntry = ConnectorTypeEntry;

function app() {
  const a = express();
  a.use('/api/connectors/catalog', catalogRouter);
  return a;
}

async function fetchTypes(): Promise<TypeEntry[]> {
  const res = await request(app()).get('/api/connectors/catalog/connector-types');
  expect(res.status).toBe(200);
  return (res.body as { types: TypeEntry[] }).types;
}

describe('GET /connector-types', () => {
  it('answers for EVERY catalog connector, not just natively implemented ones', async () => {
    const served = new Set((await fetchTypes()).map((t) => t.connectorType));
    const missing = getConnectorCatalog()
      .map((c) => c.type)
      .filter((t) => !served.has(t));
    // Any name here is a connector a customer can bind and then be unable to
    // save the team that binds it.
    expect(missing).toEqual([]);
  });

  it('includes an MCP-served connector that has no native functions', async () => {
    // github is the worked example: `status: 'available'`, bindable, and
    // deliberately absent from CONNECTOR_FUNCTIONS since it moved to the
    // official vendor-hosted MCP server.
    const entry = (await fetchTypes()).find((t) => t.connectorType === 'github');
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('engineering');
  });

  it('keeps reporting function names where they exist', async () => {
    // The fix must not flatten the response into bare names: capability
    // discovery ranks connectors by their function list.
    const entry = (await fetchTypes()).find((t) => t.connectorType === 'google_mail');
    expect(entry?.functionNames.length).toBeGreaterThan(0);
  });

  it('carries the per-call price of every platform-funded function, zero for a free source, nothing for a BYO card', async () => {
    const types = await fetchTypes();
    const byType = new Map(types.map((t) => [t.connectorType, t]));
    const locus = byType.get('locus')!;
    expect(locus.functionPrices?.email_verify).toBeCloseTo(0.008, 9);
    expect(locus.functionPrices?.startup_search).toBeCloseTo(0.0505, 9);
    for (const fn of locus.functionNames) expect(typeof locus.functionPrices?.[fn]).toBe('number');
    expect(byType.get('vaaya')!.functionPrices?.funding_rounds).toBeCloseTo(0.25, 9);
    expect(byType.get('tikhub')!.functionPrices).toBeDefined();
    expect(Object.values(byType.get('nasdaq')!.functionPrices ?? { x: 1 }).every((v) => v === 0)).toBe(true);
    expect(byType.get('hunterio')!.functionPrices).toBeUndefined();
    expect(byType.get('google_mail')!.functionPrices).toBeUndefined();
  });

  it('carries the end brand of each platform-funded data function, next to its price', async () => {
    const byType = new Map((await fetchTypes()).map((t) => [t.connectorType, t]));
    const locus = byType.get('locus')!;
    expect(locus.functionBrands?.home_listings_search_homes_for_sale).toEqual({
      brand: 'Zillow',
      category: 'Real Estate',
      label: 'Search homes for sale',
    });
    expect(byType.get('vaaya')!.functionBrands?.sec_filings_search?.brand).toBe('SEC EDGAR');
    expect(byType.get('tikhub')!.functionBrands?.tiktok_web_fetch_user_post?.brand).toBe('TikTok');
    // Only types with entries carry the field.
    expect(byType.get('browserbase_x402')?.functionBrands).toBeUndefined();
    expect(byType.get('google_mail')!.functionBrands).toBeUndefined();
  });

  it('drops no registered type that the catalog happens not to list', async () => {
    // Union, not a swap — otherwise the fix moves the outage instead of
    // removing it.
    const served = new Set((await fetchTypes()).map((t) => t.connectorType));
    const dropped = getRegisteredConnectorTypes().filter((t) => !served.has(t));
    expect(dropped).toEqual([]);
  });
});

// The per-connector functions route is how a caller learns what a function
// TAKES and what it DOES before running it. It answers from the same registry
// the names come from, so the two can never disagree.
describe('GET /connector-types/:connectorType/functions', () => {
  it('serves every natively implemented function with its schema and categories', async () => {
    const types = await fetchTypes();
    const withFunctions = types.find((t) => t.functionNames.length > 0);
    expect(withFunctions).toBeDefined();
    const res = await request(app()).get(`/api/connectors/catalog/connector-types/${withFunctions!.connectorType}/functions`);
    expect(res.status).toBe(200);
    const body = res.body as {
      connectorType: string;
      functions: Array<{ name: string; description: string; inputSchema: { type: string; properties: object }; categories: string[] }>;
    };
    expect(body.connectorType).toBe(withFunctions!.connectorType);
    expect(body.functions.map((f) => f.name)).toEqual(withFunctions!.functionNames);
    for (const f of body.functions) {
      expect(typeof f.description).toBe('string');
      expect(f.inputSchema.type).toBe('object');
      expect(Array.isArray(f.categories)).toBe(true);
    }
  });

  it('answers an empty list, not a 404, for a type with nothing native', async () => {
    const res = await request(app()).get('/api/connectors/catalog/connector-types/no_such_connector_type/functions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connectorType: 'no_such_connector_type', functions: [] });
  });
});
