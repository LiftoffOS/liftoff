// Phase C — distill catalog builder helper.
//
// Consumes the existing /api/connectors/catalog/ REST response and extracts
// the entitySchemas map per connector so the distill prompt can include a
// "CONNECTOR ENTITY SCHEMAS" section. When a connector hasn't declared its
// schemas yet, distill will fall back to recommending source.kind='computed_metric'
// for fields it can't reference.

import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';

export function buildEntitySchemasForCatalog(
  catalog: ConnectorCatalogResponse,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const def of catalog.connectors) {
    const schemas = (def as { entitySchemas?: Record<string, Record<string, unknown>> }).entitySchemas;
    if (schemas && Object.keys(schemas).length > 0) {
      out[def.type] = schemas;
    }
  }
  return out;
}
