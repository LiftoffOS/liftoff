// Embedding provider switch — first-class runtime operation.
//
// Switching a tenant's embedding provider is destructive (every
// embedding column gets NULL'd and re-embedded). This module
// encapsulates the procedure so operators have one call to make.
//
// Procedure:
//   1. Compute the new column dim from the provider's nativeDim.
//   2. ALTER COLUMN TYPE halfvec(newDim) for memories / agent_skills /
//      connector_content in one transaction.
//   3. NULL every existing embedding (vector space changes; cosine
//      across providers is meaningless).
//   4. TRUNCATE embedding_cache (stale (model, vec) pairs).
//   5. Kick the tenant's embedding-backfill Cloud Run Job (created by
//      cloudbuild step 9a).
//
// Out of scope: updating the tenant's entitlement record on
// platform-backend. That's an operator action via the platform-backend
// entitlements endpoint, performed BEFORE invoking this switch.

import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  EmbeddingProvider,
  getProviderNativeDim,
} from './embedding';

const SUPPORTED_PROVIDERS: ReadonlySet<EmbeddingProvider> = new Set(['openai', 'google', 'voyage']);

interface TableSpec {
  name: string;
  indexName: string;
  /** Extra clause appended to CREATE INDEX (e.g. partial-index WHERE). */
  indexExtra: string;
  hasModelColumn: boolean;
  /** Table is FORCE RLS, so cross-tenant maintenance needs the policy lifted
   *  for the duration of the transaction. */
  forceRls?: boolean;
}

const TABLES: TableSpec[] = [
  { name: 'memories',          indexName: 'idx_memories_embedding',          indexExtra: 'WITH (m = 16, ef_construction = 64)', hasModelColumn: true  },
  { name: 'agent_skills',      indexName: 'idx_agent_skills_hnsw',           indexExtra: "WHERE status = 'active'",             hasModelColumn: true  },
  { name: 'connector_content', indexName: 'idx_connector_content_embedding', indexExtra: 'WITH (m = 16, ef_construction = 64)', hasModelColumn: false, forceRls: true },
];

export class ProviderSwitchError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'ProviderSwitchError';
  }
}

export interface SwitchResult {
  newProvider: EmbeddingProvider;
  newDim: number;
  jobExecutionName?: string;
}

/** Performs the schema cascade + kicks the backfill job. The caller is
 *  responsible for the platform-backend entitlement update. */
export async function switchEmbeddingProvider(
  newProvider: EmbeddingProvider,
): Promise<SwitchResult> {
  if (!SUPPORTED_PROVIDERS.has(newProvider)) {
    throw new ProviderSwitchError(
      `Provider '${newProvider}' is not in the supported set: ${[...SUPPORTED_PROVIDERS].join(', ')}`,
      'validation',
    );
  }

  const newDim = getProviderNativeDim(newProvider);
  log.info({ newProvider, newDim }, 'provider-switch: starting');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const t of TABLES) {
      // A FORCE-RLS table binds its policy even to the owner, so this
      // cross-tenant re-embed cannot run under it — and with the fail-loud
      // policy form it would RAISE rather than update nothing. Lift FORCE for
      // the maintenance and put it back inside the same transaction, the same
      // wrap migrations use for a system row. Both statements are inside the
      // BEGIN/COMMIT, so a failure rolls the table back to FORCE.
      if (t.forceRls) {
        await client.query(`ALTER TABLE ${t.name} NO FORCE ROW LEVEL SECURITY`);
      }

      // Drop existing HNSW index (cannot ALTER COLUMN TYPE while indexed).
      await client.query(`DROP INDEX IF EXISTS ${t.indexName}`);

      // NULL embeddings. Schema-aware: memories/agent_skills track
      // embedding_model alongside.
      if (t.hasModelColumn) {
        await client.query(
          `UPDATE ${t.name} SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL`,
        );
      } else {
        await client.query(`UPDATE ${t.name} SET embedding = NULL WHERE embedding IS NOT NULL`);
      }

      // Swap column type.
      await client.query(`ALTER TABLE ${t.name} ALTER COLUMN embedding TYPE vector(${newDim})`);

      // Recreate HNSW index.
      await client.query(
        `CREATE INDEX ${t.indexName} ON ${t.name} ` +
        `USING hnsw (embedding vector_cosine_ops) ${t.indexExtra}`,
      );

      if (t.forceRls) {
        await client.query(`ALTER TABLE ${t.name} FORCE ROW LEVEL SECURITY`);
      }
    }

    // Wipe embedding_cache (stale model+dim pairs).
    await client.query('TRUNCATE embedding_cache');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new ProviderSwitchError(
      `Schema cascade failed: ${(err as Error).message}`,
      'schema_cascade',
    );
  } finally {
    client.release();
  }

  log.info({ newProvider, newDim }, 'provider-switch: schema cascade complete');

  // Kick the embedding-backfill Cloud Run Job. Best-effort: if the
  // kick fails, the cascade already completed and the operator can
  // execute the job manually via gcloud.
  let jobExecutionName: string | undefined;
  try {
    jobExecutionName = await kickBackfillJob();
    log.info({ jobExecutionName }, 'provider-switch: backfill job triggered');
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'provider-switch: backfill kick failed — operator should run the job manually',
    );
  }

  return { newProvider, newDim, jobExecutionName };
}

/** Calls the Cloud Run v2 admin API to start an execution of this
 *  tenant's embedding-backfill job. Returns the execution name. */
async function kickBackfillJob(): Promise<string> {
  const project = process.env.GCP_PROJECT_ID;
  const region = process.env.GCP_LOCATION ?? 'us-west1';
  const jobName = process.env.EMBED_BACKFILL_JOB_NAME ?? 'tenant-runtime-embedding-backfill';
  if (!project) {
    throw new Error('GCP_PROJECT_ID env var missing');
  }

  // Lazy-load GoogleAuth (matches the cloud-run-sandbox-provider pattern
  // — keeps non-Cloud-Run paths from paying the import cost).
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenInfo = await client.getAccessToken();
  if (!tokenInfo.token) {
    throw new Error('GoogleAuth returned empty access token');
  }

  const url = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${jobName}:run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenInfo.token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`Cloud Run Job kick returned ${res.status}: ${body}`);
  }
  const json = await res.json() as { name?: string };
  return json.name ?? 'unknown';
}
