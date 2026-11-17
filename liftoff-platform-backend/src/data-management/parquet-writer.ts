// Parquet Writer Utility
// Per Section 21: Parquet export support for data portability
// Uses Arrow-compatible Parquet format for efficient columnar storage

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/parquetjs-lite.d.ts" />
import * as parquetjs from 'parquetjs-lite';
import { EntityType } from './types';

// Type inference for Parquet schema
type ParquetFieldType = 'UTF8' | 'INT64' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP_MILLIS' | 'JSON';

interface FieldSchema {
  type: ParquetFieldType;
  optional?: boolean;
  repeated?: boolean;
}

// Schema definitions for each entity type
const ENTITY_SCHEMAS: Record<EntityType, Record<string, FieldSchema>> = {
  workflow: {
    id: { type: 'UTF8' },
    tenant_id: { type: 'UTF8' },
    objective: { type: 'UTF8', optional: true },
    status: { type: 'UTF8' },
    created_at: { type: 'TIMESTAMP_MILLIS' },
    updated_at: { type: 'TIMESTAMP_MILLIS', optional: true },
    started_at: { type: 'TIMESTAMP_MILLIS', optional: true },
    completed_at: { type: 'TIMESTAMP_MILLIS', optional: true },
    metadata: { type: 'JSON', optional: true },
  },
  action: {
    id: { type: 'UTF8' },
    tenant_id: { type: 'UTF8' },
    workflow_id: { type: 'UTF8', optional: true },
    task_id: { type: 'UTF8', optional: true },
    agent_id: { type: 'UTF8' },
    connector: { type: 'UTF8' },
    action_type: { type: 'UTF8' },
    entity_type: { type: 'UTF8' },
    payload: { type: 'JSON', optional: true },
    status: { type: 'UTF8' },
    idempotency_key: { type: 'UTF8', optional: true },
    created_at: { type: 'TIMESTAMP_MILLIS' },
    executed_at: { type: 'TIMESTAMP_MILLIS', optional: true },
  },
  usage_event: {
    id: { type: 'UTF8' },
    tenant_id: { type: 'UTF8' },
    meter_id: { type: 'UTF8' },
    value: { type: 'DOUBLE' },
    timestamp: { type: 'TIMESTAMP_MILLIS' },
    workflow_id: { type: 'UTF8', optional: true },
    agent_id: { type: 'UTF8', optional: true },
    metadata: { type: 'JSON', optional: true },
  },
  audit_log: {
    id: { type: 'UTF8' },
    tenant_id: { type: 'UTF8' },
    action: { type: 'UTF8' },
    entity_type: { type: 'UTF8' },
    entity_id: { type: 'UTF8' },
    performed_by: { type: 'UTF8', optional: true },
    details: { type: 'JSON', optional: true },
    created_at: { type: 'TIMESTAMP_MILLIS' },
  },
  connector_record: {
    id: { type: 'UTF8' },
    tenant_id: { type: 'UTF8' },
    connector_id: { type: 'UTF8' },
    external_id: { type: 'UTF8' },
    entity_type: { type: 'UTF8' },
    data: { type: 'JSON', optional: true },
    version: { type: 'INT64' },
    created_at: { type: 'TIMESTAMP_MILLIS' },
    updated_at: { type: 'TIMESTAMP_MILLIS', optional: true },
  },
  reflection: {
    id: { type: 'UTF8' },
    tenant_id: { type: 'UTF8' },
    agent_id: { type: 'UTF8' },
    trigger_type: { type: 'UTF8' },
    suggestion: { type: 'UTF8', optional: true },
    confidence_score: { type: 'DOUBLE', optional: true },
    recurrence_score: { type: 'DOUBLE', optional: true },
    severity: { type: 'UTF8', optional: true },
    evidence_refs: { type: 'JSON', optional: true },
    created_at: { type: 'TIMESTAMP_MILLIS' },
  },
  feedback: {
    id: { type: 'UTF8' },
    tenant_id: { type: 'UTF8' },
    workflow_id: { type: 'UTF8', optional: true },
    task_id: { type: 'UTF8', optional: true },
    agent_id: { type: 'UTF8', optional: true },
    escalation_type: { type: 'UTF8' },
    status: { type: 'UTF8' },
    response: { type: 'JSON', optional: true },
    created_at: { type: 'TIMESTAMP_MILLIS' },
    resolved_at: { type: 'TIMESTAMP_MILLIS', optional: true },
  },
  account: {
    id: { type: 'UTF8' },
    created_at: { type: 'TIMESTAMP_MILLIS' },
    updated_at: { type: 'TIMESTAMP_MILLIS', optional: true },
    status: { type: 'UTF8' },
    stripe_customer_id: { type: 'UTF8', optional: true },
  },
  tenant: {
    id: { type: 'UTF8' },
    account_id: { type: 'UTF8' },
    name: { type: 'UTF8' },
    status: { type: 'UTF8' },
    database_tier: { type: 'UTF8', optional: true },
    created_at: { type: 'TIMESTAMP_MILLIS' },
    updated_at: { type: 'TIMESTAMP_MILLIS', optional: true },
  },
};

export class ParquetWriter {
  // Convert data to Parquet format and return as Buffer
  async writeToBuffer(
    entityType: EntityType,
    data: Record<string, unknown>[]
  ): Promise<Buffer> {
    if (data.length === 0) {
      return Buffer.alloc(0);
    }

    const schema = this.buildSchema(entityType, data);
    const writer = await parquetjs.ParquetWriter.openBuffer(schema);

    for (const row of data) {
      const parquetRow = this.convertRow(row, entityType);
      await writer.appendRow(parquetRow);
    }

    await writer.close();
    return writer.toBuffer();
  }

  // Write multiple entity types to a single Parquet file with partitioning
  async writeMultipleEntityTypes(
    allData: Record<EntityType, Record<string, unknown>[]>
  ): Promise<Buffer> {
    // For multiple entity types, we create a unified schema with entity_type column
    const combinedData: Array<Record<string, unknown>> = [];

    for (const [entityType, records] of Object.entries(allData)) {
      for (const record of records) {
        combinedData.push({
          _entity_type: entityType,
          _raw_data: JSON.stringify(record),
          id: record.id,
          tenant_id: record.tenant_id,
          created_at: record.created_at,
        });
      }
    }

    if (combinedData.length === 0) {
      return Buffer.alloc(0);
    }

    const schema = new parquetjs.ParquetSchema({
      _entity_type: { type: 'UTF8' },
      _raw_data: { type: 'UTF8' },
      id: { type: 'UTF8' },
      tenant_id: { type: 'UTF8' },
      created_at: { type: 'TIMESTAMP_MILLIS', optional: true },
    });

    const writer = await parquetjs.ParquetWriter.openBuffer(schema);

    for (const row of combinedData) {
      await writer.appendRow({
        _entity_type: row._entity_type,
        _raw_data: row._raw_data,
        id: row.id as string,
        tenant_id: row.tenant_id as string,
        created_at: row.created_at ? new Date(row.created_at as string).getTime() : null,
      });
    }

    await writer.close();
    return writer.toBuffer();
  }

  private buildSchema(
    entityType: EntityType,
    data: Record<string, unknown>[]
  ): parquetjs.ParquetSchema {
    const schemaDefinition = ENTITY_SCHEMAS[entityType];

    if (!schemaDefinition) {
      // Fallback: infer schema from first row
      return this.inferSchema(data[0]);
    }

    return new parquetjs.ParquetSchema(schemaDefinition);
  }

  private inferSchema(sample: Record<string, unknown>): parquetjs.ParquetSchema {
    const schemaFields: Record<string, FieldSchema> = {};

    for (const [key, value] of Object.entries(sample)) {
      schemaFields[key] = this.inferFieldType(value);
    }

    return new parquetjs.ParquetSchema(schemaFields);
  }

  private inferFieldType(value: unknown): FieldSchema {
    if (value === null || value === undefined) {
      return { type: 'UTF8', optional: true };
    }

    if (typeof value === 'boolean') {
      return { type: 'BOOLEAN', optional: true };
    }

    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { type: 'INT64', optional: true };
      }
      return { type: 'DOUBLE', optional: true };
    }

    if (value instanceof Date) {
      return { type: 'TIMESTAMP_MILLIS', optional: true };
    }

    if (typeof value === 'object') {
      return { type: 'JSON', optional: true };
    }

    // Check if string looks like a timestamp
    if (typeof value === 'string') {
      const timestamp = Date.parse(value);
      if (!isNaN(timestamp) && value.includes('-') && value.includes(':')) {
        return { type: 'TIMESTAMP_MILLIS', optional: true };
      }
    }

    return { type: 'UTF8', optional: true };
  }

  private convertRow(
    row: Record<string, unknown>,
    entityType: EntityType
  ): Record<string, unknown> {
    const schema = ENTITY_SCHEMAS[entityType] || {};
    const converted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      const fieldSchema = schema[key];

      if (!fieldSchema) {
        // Skip fields not in schema
        continue;
      }

      converted[key] = this.convertValue(value, fieldSchema.type);
    }

    return converted;
  }

  private convertValue(value: unknown, targetType: ParquetFieldType): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    switch (targetType) {
      case 'UTF8':
        return String(value);

      case 'INT64':
        return typeof value === 'number' ? Math.floor(value) : parseInt(String(value), 10);

      case 'DOUBLE':
        return typeof value === 'number' ? value : parseFloat(String(value));

      case 'BOOLEAN':
        return Boolean(value);

      case 'TIMESTAMP_MILLIS':
        if (value instanceof Date) {
          return value.getTime();
        }
        if (typeof value === 'string') {
          return new Date(value).getTime();
        }
        if (typeof value === 'number') {
          return value;
        }
        return null;

      case 'JSON':
        return typeof value === 'string' ? value : JSON.stringify(value);

      default:
        return String(value);
    }
  }
}

// Export singleton instance
export const parquetWriter = new ParquetWriter();
