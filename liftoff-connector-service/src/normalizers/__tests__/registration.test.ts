// Smoke test: boot-time registration populates CONNECTOR_ENTITY_SCHEMAS.
// Verifies the wiring described in §5.1 of the implementation plan.

import '../index';
import { CONNECTOR_ENTITY_SCHEMAS } from '../../catalog/connector-entity-schemas';
import { CONNECTORS } from '../../catalog/connectors';

describe('Connector entity-schema registration (boot-time)', () => {
  it('CONNECTOR_ENTITY_SCHEMAS is non-empty after boot', () => {
    const types = Object.keys(CONNECTOR_ENTITY_SCHEMAS);
    expect(types.length).toBeGreaterThan(0);
  });

  it('every registered connector publishes at least one entity schema', () => {
    for (const [_type, schemas] of Object.entries(CONNECTOR_ENTITY_SCHEMAS)) {
      expect(Object.keys(schemas).length).toBeGreaterThan(0);
    }
  });

  // Invariant: a connector marked listImplemented:true is actually pollable —
  // its polled entityType must have a registered entity schema, or distill
  // rejects predicates on the served entity (and the scheduler logs churn).
  // This guards the youtube (no normalizer) + outlook (entityType-vs-schema-key
  // mismatch) regressions.
  it('every listImplemented:true polling entity has a registered entity schema', () => {
    const violations: string[] = [];
    for (const [type, def] of Object.entries(CONNECTORS)) {
      for (const p of def.polling ?? []) {
        if (!p.listImplemented) continue;
        const schema = (CONNECTOR_ENTITY_SCHEMAS[type] ?? {})[p.entityType] as
          | { properties?: Record<string, unknown> }
          | undefined;
        if (!schema?.properties || Object.keys(schema.properties).length === 0) {
          violations.push(`${type}/${p.entityType}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every emitted entity schema declares an `id` field', () => {
    const failures: string[] = [];
    for (const [connectorType, schemas] of Object.entries(CONNECTOR_ENTITY_SCHEMAS)) {
      for (const [entityType, schema] of Object.entries(schemas)) {
        const s = schema as { properties?: Record<string, unknown> };
        if (!s.properties || typeof s.properties !== 'object' || !('id' in s.properties)) {
          failures.push(`${connectorType}.${entityType}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
