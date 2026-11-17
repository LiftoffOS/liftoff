// Startup verifier — confirms every embedding column in this tenant's
// runtime DB has type vector(ACTIVE_DIM). Called from src/index.ts
// after migrations run and before the HTTP listener binds. Fail-loud
// at startup is the migration-258 lesson: silent-NULL inserts because
// of column/code dim drift are not acceptable.
//
// The columns are vector(768), not halfvec(3072), because the Vertex
// API returns 400 on outputDimensionality=3072. See migration 263.

import { pool } from '../infrastructure/database';
import { ACTIVE_DIM } from './embedding';
import { log } from '../infrastructure/logging';

const TABLES = ['memories', 'agent_skills', 'connector_content'] as const;

interface ColumnInfo {
  table: string;
  typeName: string;
  declaredDim: number;
}

async function getEmbeddingColumnInfo(table: string): Promise<ColumnInfo> {
  // pg_attribute.atttypmod for pgvector types is the dim directly
  // (no -4 offset like varchar). pg_type.typname distinguishes
  // halfvec / vector / sparsevec.
  const r = await pool.query<{ typname: string; atttypmod: number }>(`
    SELECT t.typname, a.atttypmod
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = $1::regclass
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `, [table]);

  if (r.rows.length === 0) {
    throw new Error(`dim-bind: table '${table}' has no 'embedding' column`);
  }

  return { table, typeName: r.rows[0].typname, declaredDim: r.rows[0].atttypmod };
}

/** Throws if any embedding column is not vector(ACTIVE_DIM). */
export async function verifyEmbeddingDimCascade(): Promise<void> {
  const results = await Promise.all(TABLES.map(getEmbeddingColumnInfo));

  const mismatches = results.filter(
    info => info.typeName !== 'vector' || info.declaredDim !== ACTIVE_DIM,
  );

  if (mismatches.length > 0) {
    const detail = mismatches
      .map(m => `${m.table}: type=${m.typeName}, dim=${m.declaredDim}`)
      .join('; ');
    throw new Error(
      `dim-bind: cascade mismatch. Expected vector(${ACTIVE_DIM}) on every ` +
      `embedding column. Got: ${detail}. Run migration 263, or use the ` +
      `provider-switch runbook to align.`,
    );
  }

  log.info(
    { activeDim: ACTIVE_DIM, tables: TABLES },
    'dim-bind: vector cascade verified',
  );
}
