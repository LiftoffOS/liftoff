// Backfill capability_embedding for all active agents that have null embeddings.
//
// Run once after deploying migration 151 (pgvector + capability_embedding column).
//
// Usage:
//   DATABASE_URL=postgres://... OPENAI_API_KEY=... \
//   npx ts-node --project tsconfig.json scripts/backfill-agent-embeddings.ts
//
// The script processes agents in batches of 20 with a 1-second pause between
// batches to avoid hammering the OpenAI embeddings endpoint.
// It is safe to re-run — agents with non-null capability_embedding are skipped.

import { Pool } from 'pg';
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
  responsibilities: string | null;
  summary: string | null;
  capabilities: unknown;
}

function buildEmbeddingText(agent: AgentRow): string {
  const capabilitiesText = Array.isArray(agent.capabilities)
    ? (agent.capabilities as string[]).join(', ')
    : typeof agent.capabilities === 'string'
      ? agent.capabilities
      : '';
  return [agent.role, agent.responsibilities, agent.summary, capabilitiesText]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const openai = new OpenAI({ apiKey });

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM internal_agents
       WHERE status = 'active' AND deleted_at IS NULL AND capability_embedding IS NULL`,
    );
    const total = parseInt(countResult.rows[0].count, 10);
    console.log(`Agents to backfill: ${total}`);

    let offset = 0;
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    while (offset < total) {
      const result = await pool.query<AgentRow>(
        `SELECT id, tenant_id, role, responsibilities, summary, capabilities
         FROM internal_agents
         WHERE status = 'active' AND deleted_at IS NULL AND capability_embedding IS NULL
         ORDER BY created_at ASC
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      );

      if (result.rows.length === 0) break;

      for (const agent of result.rows) {
        const text = buildEmbeddingText(agent);
        if (!text) {
          skipped++;
          continue;
        }

        try {
          const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: text,
            dimensions: EMBEDDING_DIMENSIONS,
          });
          const embedding = response.data[0].embedding;

          await pool.query(
            `UPDATE internal_agents SET capability_embedding = $1 WHERE id = $2`,
            [`[${embedding.join(',')}]`, agent.id],
          );

          processed++;
          if (processed % 10 === 0) {
            console.log(`  embedded ${processed} / ${total - skipped} (skipped ${skipped}, failed ${failed})`);
          }
        } catch (err) {
          failed++;
          console.error(`  failed agent ${agent.id}: ${(err as Error).message}`);
        }
      }

      offset += result.rows.length;
      if (offset < total) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    console.log(`Done. embedded=${processed}, skipped=${skipped}, failed=${failed}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
