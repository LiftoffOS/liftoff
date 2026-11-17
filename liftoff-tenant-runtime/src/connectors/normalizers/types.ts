// Connector Normalizer Types
// Per Section 12: Normalized records are written into tenant Cloud SQL

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
  normalize(payload: unknown): NormalizedRecord[];
  extractEntityType(record: unknown): string;
  extractExternalId(record: unknown): string;
  extractVersion?(record: unknown): string | undefined;
}
