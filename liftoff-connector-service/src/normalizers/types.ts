// Connector Normalizer Types
// Per Section 12: Normalized records are written into tenant Cloud SQL

import type { JSONSchema7 } from 'json-schema';

export interface NormalizedRecord {
  entityType: string;
  externalId: string;
  data: Record<string, unknown>;
  metadata: {
    source: string;
    syncedAt: Date;
    version: string;
    etag?: string;
  };
}

export interface ConnectorNormalizer {
  connectorType: string;
  // Per-entity JSON Schema map derived from the same Zod schemas the normalizer
  // uses to parse vendor payloads (zod-to-json-schema). Single source of truth:
  // adding/removing a field in the Zod schema automatically updates what the
  // catalog publishes. Boot-time registration loop (normalizers/index.ts) feeds
  // these into CONNECTOR_ENTITY_SCHEMAS so the catalog endpoint and platform-
  // backend's distill-time analyzer can read them generically.
  entitySchemas: Record<string, JSONSchema7>;
  normalize(payload: unknown): NormalizedRecord[];
  extractEntityType(record: unknown): string;
  extractExternalId(record: unknown): string;
  extractVersion?(record: unknown): string | undefined;
}
