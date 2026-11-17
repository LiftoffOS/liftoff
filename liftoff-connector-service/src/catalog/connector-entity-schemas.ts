// Connector entity-schemas registry.
//
// Each connector author calls registerConnectorEntitySchemas('its-name', { ... })
// from its own module to declare the JSON-Schema of fields it publishes on
// each entityType. The platform reads this registry generically (no vendor
// names hardcoded) and surfaces it via the existing /api/connectors/catalog/
// REST endpoint so distill prompts can reference real paths and the validator
// can confirm subscription predicates point at fields that exist.

import type { JSONSchema7 } from 'json-schema';

export const CONNECTOR_ENTITY_SCHEMAS: Record<string, Record<string, JSONSchema7>> = {};

export function registerConnectorEntitySchemas(
  connectorType: string,
  schemas: Record<string, JSONSchema7>,
): void {
  CONNECTOR_ENTITY_SCHEMAS[connectorType] = {
    ...(CONNECTOR_ENTITY_SCHEMAS[connectorType] ?? {}),
    ...schemas,
  };
}
