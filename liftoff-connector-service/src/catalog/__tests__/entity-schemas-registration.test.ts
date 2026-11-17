// Verifies that the type-enforced ConnectorNormalizer.entitySchemas contract
// is wired through to the CONNECTOR_ENTITY_SCHEMAS registry at boot, and that
// the connectors with rich schemas declare the deadline-anchoring fields that
// the platform-backend distill prompt's I1 invariant predicates on.
//
// Importing the normalizers index runs the boot-time registration loop, so by
// the time this test executes, the registry should be populated.

import { CONNECTOR_ENTITY_SCHEMAS } from '../connector-entity-schemas.js';
// Side-effect import triggers boot-time `registerConnectorEntitySchemas` calls
// for every normalizer registered in `normalizers/index.ts`.
import '../../normalizers/index.js';

describe('CONNECTOR_ENTITY_SCHEMAS — boot-time registration', () => {
  it('is populated after the normalizers index loads (was {} pre-mechanism)', () => {
    expect(Object.keys(CONNECTOR_ENTITY_SCHEMAS).length).toBeGreaterThan(0);
  });

  it.each([
    ['hubspot', 'Deal', /closeDate/],
    ['salesforce', 'Opportunity', /closeDate/],
    // Entity keys + deadline-anchor fields match each normalizer's actual
    // entitySchemas (the shipped source of truth), not an aspirational name.
    ['google_calendar', 'CalendarEvent', /startDateTime/],
    ['microsoft_outlook_calendar', 'Event', /\bstart\b/],
    ['linear', 'Issue', /dueDate/],
    ['jira', 'Issue', /dueDate/],
    ['zendesk', 'Ticket', /dueAt/],
    ['microsoft_todo', 'Task', /dueDateTime/],
    ['microsoft_planner', 'Task', /dueDateTime/],
    ['granola', 'MeetingNotes', /started_at/],
    ['zoom', 'MeetingNotes', /started_at/],
  ])('%s.%s declares a deadline-anchor field matching %s', (connectorType, entityType, deadlineFieldRe) => {
    const schemas = CONNECTOR_ENTITY_SCHEMAS[connectorType];
    expect(schemas).toBeDefined();
    expect(schemas[entityType]).toBeDefined();
    expect(JSON.stringify(schemas[entityType])).toMatch(deadlineFieldRe);
  });

  it('every registered connector declares at least the id field via BASE_NORMALIZED_FIELDS (or empty for opt-out)', () => {
    for (const [connectorType, entityMap] of Object.entries(CONNECTOR_ENTITY_SCHEMAS)) {
      // Empty {} is permitted — opts out of I1 / reactive validation for that connector.
      // Non-empty maps MUST have at least one entity with an `id` field declared.
      if (Object.keys(entityMap).length === 0) continue;
      for (const [entityType, schema] of Object.entries(entityMap)) {
        const json = JSON.stringify(schema);
        expect(json).toMatch(/"id"/);
        // Sanity: schema must be a JSONSchema-shaped object
        expect((schema as { type?: string }).type).toBe('object');
        if (!entityType) throw new Error(`empty entityType for ${connectorType}`);
      }
    }
  });
});
