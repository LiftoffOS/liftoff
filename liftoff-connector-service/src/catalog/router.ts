// Connector catalog HTTP router.
//
// Serves the unified CONNECTORS registry as JSON so the frontend and
// platform-backend can render the connector picker without maintaining
// their own copies. Response shape matches
// @liftoffos/connector-types::ConnectorCatalogResponse:
//
//   {
//     connectors:     ConnectorDef[]   — sorted by type
//     version:        string           — changes whenever the registry does
//     categoryLabels: Record<ConnectorCategory, string>
//   }
//
// Mount path: /api/connectors/catalog. Mounted BEFORE the CRUD router so
// it wins route matching against the more generic /api/connectors prefix.

import { Router, type Request, type Response } from 'express';
import type {
  ConnectorCatalogResponse,
  ConnectorCategory,
} from '@liftoffos/connector-types';
import { CATEGORY_DISPLAY_LABELS, computeCatalogVersion } from './connectors.js';
import { getConnectorCatalog } from './projections.js';
import { getConnectorFunctions, getRegisteredConnectorTypes } from './connector-functions-registry.js';
import { getFunctionPrices } from './function-prices.js';
import { getFunctionBrandsFor, type FunctionBrand } from './function-brands.js';

export const catalogRouter = Router();

/** One entry of GET /connector-types. Local to this service: the response
 *  has no type in @liftoffos/connector-types. */
export interface ConnectorTypeEntry {
  connectorType: string;
  category: string;
  functionNames: string[];
  listImplemented: boolean;
  /** Function name → USD a call, for platform-funded types only. */
  functionPrices?: Record<string, number>;
  /** Function name → the end brand, its /data-sources category and a label
   *  for the call, for the platform-funded data types only. */
  functionBrands?: Record<string, FunctionBrand>;
}

// WS-5.2 — authoritative connector-type registry endpoint.
// Returns {connectorType, category, functionNames[], listImplemented} for
// every type this service serves. PB caches this (60s TTL) and uses it as an
// EXISTENCE check when writing internal_agents.integrations.
//
// ENUMERATES THE CATALOG, not the function registry, and the difference is the
// whole point. `getRegisteredConnectorTypes()` answers "which types have native
// CONNECTOR_FUNCTIONS" — a question about implementation. A connector served by
// a vendor-hosted or sidecar MCP server has none by construction: its tools are
// discovered from the server at run time. Answering the existence question with
// the implementation list makes every such connector read as though it does not
// exist, and PB then refuses to save ANY team bound to one — not its bindings,
// its prose or its model, because the write path re-validates the whole
// integrations array on every save. GitHub reached that state the day it moved
// to the official MCP server and left CONNECTOR_FUNCTIONS behind.
//
// `functionNames` stays honest and is empty for those types. It describes what
// is natively implemented; consumers already treat it as optional
// (capability-discovery reads `meta?.functionNames ?? []`), and an empty list is
// the correct answer for a connector whose tools live on its MCP server.
//
// `functionPrices` (function name → USD a call, function-prices.ts) rides
// along for the platform-funded types, so discovery can rank on cost; absent
// for every other type, where the price is the workspace's own business.
// `functionBrands` (function-brands.ts) rides next to it for the data types:
// who each call's data comes from, so the dashboard's Data Sources page can list sources by
// brand. Absent where a type has no mapped function.
catalogRouter.get('/connector-types', (_req: Request, res: Response) => {
  const catalog = getConnectorCatalog();
  const catalogByType = new Map(catalog.map((c) => [c.type, c]));
  // Union, not a swap. A registered type the catalog does not list is still
  // served, and dropping it here would move the outage rather than fix it.
  const connectorTypes = [
    ...new Set([...catalogByType.keys(), ...getRegisteredConnectorTypes()]),
  ];
  const types = connectorTypes.map((connectorType): ConnectorTypeEntry => {
    const def = catalogByType.get(connectorType);
    const functions = getConnectorFunctions(connectorType);
    const functionPrices = getFunctionPrices(connectorType);
    const functionBrands = getFunctionBrandsFor(connectorType);
    return {
      connectorType,
      category: def?.category ?? 'unknown',
      functionNames: functions.map((f) => f.name),
      listImplemented: false,
      ...(functionPrices ? { functionPrices } : {}),
      ...(functionBrands ? { functionBrands } : {}),
    };
  });
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ types });
});

// What a connector's natively implemented functions ARE, one connector at a
// time: name, description, input schema and the categories its author gave it.
// The list above ships names only, because it is read on every catalog pass;
// this is read when a caller is about to run, classify or describe ONE
// function, which is when the name is not enough — an argument is a list or a
// comma-separated string, a call is a read or a write — and the author's own
// answer is the one to use. Empty for a type whose tools live on an MCP server,
// exactly as `functionNames` is; unknown types are empty too, never a 404,
// because absence here means "nothing native", not "no such connector".
//
// `routingSchema` rides along where a function has one: the caller validates a
// candidate's arguments against it before dispatching, so a source that would
// refuse them costs no call. It is for that check alone and never reaches a
// model — the tool definition a model reads is built from `inputSchema`.
catalogRouter.get('/connector-types/:connectorType/functions', (req: Request, res: Response) => {
  const connectorType = String(req.params.connectorType ?? '');
  const functions = getConnectorFunctions(connectorType).map((f) => ({
    name: f.name,
    description: f.description,
    inputSchema: f.inputSchema,
    ...(f.routingSchema ? { routingSchema: f.routingSchema } : {}),
    categories: f.categories,
    ...(f.draftVariant ? { draftVariant: f.draftVariant } : {}),
  }));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ connectorType, functions });
});

/**
 * Returns the full connector catalog. No tenant context required — the
 * catalog is platform-wide metadata, not per-tenant state.
 *
 * Cache-Control hints tell upstream proxies this is safe to cache for
 * five minutes; the version string on the response lets clients
 * invalidate early when the registry changes.
 */
catalogRouter.get('/', (req: Request, res: Response) => {
  // Every caller of this service is a service (the whole app sits behind
  // X-Service-Auth), so "is this the dashboard asking" cannot be read off the
  // auth. platform-backend's user-facing proxy marks the requests that
  // originate from a person's browser with this header; those get the
  // user-facing view, with 'internal' connectors filtered out server-side so
  // no connector card can exist for them. Direct service callers
  // (distillation, assistants, the tenant runtime) see the full registry.
  const userFacing = req.get('x-catalog-view') === 'user';
  const connectors = userFacing
    ? getConnectorCatalog().filter((c) => c.status !== 'internal')
    : getConnectorCatalog();
  const body: ConnectorCatalogResponse = {
    connectors,
    version: computeCatalogVersion(),
    categoryLabels: CATEGORY_DISPLAY_LABELS as Record<ConnectorCategory, string>,
  };
  res.set('Cache-Control', 'public, max-age=300');
  // The response now varies by view; without this a shared cache could serve
  // the full registry to a browser or the filtered one to a service.
  res.set('Vary', 'x-catalog-view');
  res.json(body);
});
