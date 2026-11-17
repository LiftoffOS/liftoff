// Generic Composio poll normalizer.
//
// One ConnectorNormalizer, constructed per spec'd connector, that interprets a
// ComposioPollSpec: reads the `__pollEntity` discriminator the generic client
// stamps, maps raw vendor fields via the entity's `fields` map, and builds the
// published entity schema (JSON Schema) from those field types so distill
// predicates can reference real paths. Replaces the per-connector bespoke
// normalizers.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';
import type { ComposioPollSpec, PollEntity, FieldSpec } from '../polling/composio-poll-spec.js';
import { getPath } from '../clients/composio-generic-poll-client.js';

// External id: the id path, or a stable content hash when empty + idFallbackHash
// (e.g. Datadog events with null ids — dropped otherwise). The hash excludes the
// internal `__pollEntity` marker so it matches the generic client's raw-record
// hash (recordId) for the same record.
function recordExternalId(row: Record<string, unknown>, ent: PollEntity): string {
  const id = String(getPath(row, ent.idField ?? 'id') ?? '');
  if (id) return id;
  if (!ent.idFallbackHash) return '';
  const { __pollEntity, ...raw } = row; // eslint-disable-line @typescript-eslint/no-unused-vars
  return hashCanonicalJson(raw);
}

function coerceString(v: unknown): string | undefined {
  if (v == null) return undefined;
  return typeof v === 'string' ? v : String(v);
}
function coerceNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n : undefined;
}

// First non-null value across a list of alternative dot-paths.
function firstDefinedPath(row: Record<string, unknown>, paths: string[]): unknown {
  for (const p of paths) { const v = getPath(row, p); if (v != null) return v; }
  return undefined;
}

// Extract one field from a raw record per its FieldSpec.
function extractField(row: Record<string, unknown>, fs: FieldSpec): unknown {
  const raw = fs.paths ? firstDefinedPath(row, fs.paths) : getPath(row, fs.path);
  if (fs.fromTag) {
    // `raw` is a key:value string array; return the suffix of the first entry
    // whose key matches fs.fromTag (e.g. tags ['env:prod'] + fromTag 'env' → 'prod').
    const prefix = `${fs.fromTag}:`;
    const arr = Array.isArray(raw) ? raw : [];
    const hit = arr.find(t => typeof t === 'string' && t.startsWith(prefix)) as string | undefined;
    return hit ? hit.slice(prefix.length) : undefined;
  }
  if (fs.kind === 'string[]') {
    const arr = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
    return arr
      .map(el => (fs.from && el && typeof el === 'object' ? (el as Record<string, unknown>)[fs.from] : el))
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  let base: unknown = raw;
  if (fs.pick === 'first') {
    const first = Array.isArray(raw) && raw.length ? raw[0] : undefined;
    base = fs.from && first && typeof first === 'object' ? (first as Record<string, unknown>)[fs.from] : first;
  } else if (fs.from && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    base = (raw as Record<string, unknown>)[fs.from];
  }
  return fs.kind === 'number' ? coerceNumber(base) : coerceString(base);
}

// FieldSpec → zod (for entity-schema publication + runtime parse tolerance).
function fieldZod(fs: FieldSpec): z.ZodTypeAny {
  const base = fs.kind === 'number' ? z.number() : fs.kind === 'string[]' ? z.array(z.string()) : z.string();
  const withDesc = fs.describe ? base.describe(fs.describe) : base;
  return fs.kind === 'string[]' ? withDesc : withDesc.optional();
}

function entityZod(ent: PollEntity): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = { id: z.string() };
  for (const [name, fs] of Object.entries(ent.fields)) shape[name] = fieldZod(fs);
  return z.object(shape);
}

export class ComposioGenericNormalizer implements ConnectorNormalizer {
  readonly connectorType: string;
  readonly entitySchemas: Record<string, JSONSchema7>;
  private readonly schemaByEntity: Record<string, z.ZodTypeAny>;

  constructor(private readonly spec: ComposioPollSpec) {
    this.connectorType = spec.connectorType;
    const zodByEntity: Record<string, z.ZodTypeAny> = {};
    for (const ent of spec.entities) zodByEntity[ent.entityType] = entityZod(ent);
    this.schemaByEntity = zodByEntity;
    this.entitySchemas = buildEntitySchemas(zodByEntity);
  }

  private entityFor(row: Record<string, unknown>): PollEntity {
    const key = row.__pollEntity;
    return this.spec.entities.find(e => e.entityType === key) ?? this.spec.entities[0];
  }

  normalize(payload: unknown): NormalizedRecord[] {
    const rows = (payload as { results?: Array<Record<string, unknown>> })?.results ?? [];
    const out: NormalizedRecord[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const ent = this.entityFor(row);
      const externalId = recordExternalId(row, ent);
      if (!externalId) continue;
      const mapped: Record<string, unknown> = { id: externalId };
      for (const [name, fs] of Object.entries(ent.fields)) mapped[name] = extractField(row, fs);
      // Version anchors on versionField (change timestamp) if set, else the
      // since field, else a content hash. Falls back through when a value is empty.
      const versionPath = ent.versionField ?? ent.since?.field;
      const version = (versionPath && coerceString(getPath(row, versionPath)))
        || (ent.since?.field && coerceString(getPath(row, ent.since.field)))
        || hashCanonicalJson(row);
      out.push({
        entityType: ent.entityType,
        externalId,
        data: this.schemaByEntity[ent.entityType].parse(mapped) as Record<string, unknown>,
        metadata: { source: this.connectorType, syncedAt: new Date(), version },
      });
    }
    return out;
  }

  extractEntityType(record: unknown): string {
    const r = record as Record<string, unknown>;
    const key = r?.__pollEntity;
    return typeof key === 'string' ? key : this.spec.entities[0].entityType;
  }

  extractExternalId(record: unknown): string {
    const r = record as Record<string, unknown>;
    return recordExternalId(r ?? {}, this.entityFor(r ?? {}));
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as Record<string, unknown>;
    const ent = this.entityFor(r ?? {});
    const path = ent.versionField ?? ent.since?.field;
    return path ? coerceString(getPath(r, path)) : undefined;
  }
}
