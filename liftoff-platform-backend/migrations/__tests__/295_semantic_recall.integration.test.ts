// Migration 295 + semantic recall (v2) — DB-backed integration tests
// (plan v6 Change 8.5; requires TEST_DATABASE_URL).
//
// Runs the REAL semantic query (AGENT_CONVERSATIONS_SEMANTIC_SQL, exported
// from platform-tools-router) against the real schema under tenant context
// with hand-built orthogonal vectors, so cosine ordering, space gating, and
// the privacy predicates exercise actual SQL semantics — never mocks.
//
// Run after migrations complete:
//   npx jest --config jest.integration.config.js migrations/__tests__/295_semantic_recall.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import {
  AGENT_CONVERSATIONS_SEMANTIC_SQL,
  AGENT_CONVERSATIONS_SQL,
} from '../../src/internal-api/platform-tools-router';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const DIMS = 768;
const SPACE = { provider: 'google', model: 'gemini-embedding-001' };

/** 768-d unit vector with 1 at index i. */
function unit(i: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[i] = 1;
  return v;
}

function literal(v: number[]): string {
  return `[${v.join(',')}]`;
}

interface SemanticTurnRow {
  turn_id: string;
  thread_id: string;
  channel: string;
  created_at: Date;
  messages: Array<{ role: string; preview: string; created_at: string }>;
  similarity: number;
}

/** Run the semantic query under the given tenant's RLS context. */
async function semanticRecall(
  client: PoolClient,
  tenantId: string,
  agentId: string,
  accountId: string,
  queryVector: number[],
  opts: {
    rawLower?: string;
    excludeTurnId?: string;
    limit?: number;
    provider?: string;
    model?: string;
  } = {},
): Promise<SemanticTurnRow[]> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
  const result = await client.query(AGENT_CONVERSATIONS_SEMANTIC_SQL, [
    tenantId,
    agentId,
    accountId,
    opts.limit ?? 10,
    literal(queryVector),
    opts.excludeTurnId ?? null,
    opts.rawLower ?? 'no-such-substring',
    opts.provider ?? SPACE.provider,
    opts.model ?? SPACE.model,
  ]);
  await client.query('COMMIT');
  return result.rows as SemanticTurnRow[];
}

/** Run the v1 keyword query (for the mismatch-reachable-via-keyword case). */
async function keywordRecall(
  client: PoolClient,
  tenantId: string,
  agentId: string,
  accountId: string,
  query: string,
): Promise<Array<{ turn_id: string }>> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
  const pattern = `%${query.replace(/[%_\\]/g, '\\$&')}%`;
  const result = await client.query(AGENT_CONVERSATIONS_SQL, [
    tenantId, agentId, accountId, 10, pattern, null, query.toLowerCase(),
  ]);
  await client.query('COMMIT');
  return result.rows;
}

/** Insert a thread + attributed turn with messages and (optionally) a vector. */
async function seedEmbeddedTurn(
  client: PoolClient,
  args: {
    tenantId: string;
    agentId: string;
    senderAccountId: string | null;
    userContent: string;
    embedding?: number[];        // omit → NULL vector
    provider?: string;
    model?: string;
    createdAt?: string;          // ISO; tie-breaker determinism
    threadId?: string;
  },
): Promise<{ threadId: string; turnId: string }> {
  const threadId = args.threadId ?? randomUUID();
  const turnId = randomUUID();
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [args.tenantId]);
  if (!args.threadId) {
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
       VALUES ($1, $2, $3, 'web', 'semantic recall test thread')`,
      [threadId, args.tenantId, args.senderAccountId],
    );
  }
  await client.query(
    `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))`,
    [turnId, args.tenantId, threadId, args.agentId, args.senderAccountId, args.createdAt ?? null],
  );
  if (args.embedding) {
    await client.query(
      `UPDATE agent_chat_turns
          SET content_embedding = $1,
              content_embedding_provider = $2,
              content_embedding_model = $3
        WHERE id = $4 AND tenant_id = $5`,
      [literal(args.embedding), args.provider ?? SPACE.provider, args.model ?? SPACE.model, turnId, args.tenantId],
    );
  }
  await client.query(
    `INSERT INTO agent_chat_messages (tenant_id, thread_id, role, content, turn_id)
     VALUES ($1, $2, 'user', $3, $4)`,
    [args.tenantId, threadId, args.userContent, turnId],
  );
  await client.query(
    `INSERT INTO agent_chat_messages (tenant_id, thread_id, agent_id, role, content, turn_id)
     VALUES ($1, $2, $3, 'assistant', 'reply', $4)`,
    [args.tenantId, threadId, args.agentId, turnId],
  );
  await client.query('COMMIT');
  return { threadId, turnId };
}

describeFn('Semantic recall (migration 295)', () => {
  let pool: Pool;
  let client: PoolClient;

  const tenantA = '00000000-0000-0000-0000-00000000d0aa';
  const tenantB = '00000000-0000-0000-0000-00000000d0bb';
  const acctA = '00000000-0000-0000-0000-00000000adc1';
  const acctB = '00000000-0000-0000-0000-00000000adc2';
  const agentA = '00000000-0000-0000-0000-00000000ada1';
  const agentB = '00000000-0000-0000-0000-00000000adb1';

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();

    await client.query('BEGIN');
    for (const [id, email] of [
      [acctA, 'semantic-a@test.invalid'],
      [acctB, 'semantic-b@test.invalid'],
    ] as const) {
      await client.query(
        `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
         VALUES ($1, $2, 'Semantic', 'Test', $3, 'UTC', 1)
         ON CONFLICT (id) DO NOTHING`,
        [id, `semantic-test-${id.slice(-4)}`, email],
      );
    }
    for (const [id, name] of [
      [tenantA, 'Semantic Tenant A'],
      [tenantB, 'Semantic Tenant B'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
         VALUES ($1, $2, $3, 'standard', 'shared', 'pending', 'pending')
         ON CONFLICT (id) DO NOTHING`,
        [id, acctA, name],
      );
    }
    await client.query('COMMIT');

    for (const [agentId, tenantId] of [
      [agentA, tenantA],
      [agentB, tenantB],
    ] as const) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'Semantic Test Agent')
         ON CONFLICT (id) DO NOTHING`,
        [agentId, tenantId],
      );
      await client.query('COMMIT');
    }
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [t]);
      await client.query(`DELETE FROM agent_chat_messages WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM agent_chat_turns WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM agent_chat_thread_participants WHERE thread_id IN (SELECT id FROM agent_chat_threads WHERE tenant_id = $1)`, [t]);
      await client.query(`DELETE FROM agent_chat_threads WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM internal_agents WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [t]);
      await client.query('COMMIT');
    }
    await client.query(`DELETE FROM accounts WHERE id IN ($1, $2)`, [acctA, acctB]);
    client.release();
    await pool.end();
  });

  it('orders by exact cosine similarity with deterministic tie-breakers', async () => {
    const { turnId: exact } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'cosine order exact', embedding: unit(0),
    });
    const { turnId: near } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'cosine order near',
      embedding: (() => { const v = unit(0); v[1] = 0.5; return v; })(),
    });
    const { turnId: orthogonal } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'cosine order orthogonal', embedding: unit(1),
    });
    // Tie pair: identical vectors, distinct created_at → newer first.
    const { turnId: tieOld } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'tie old', embedding: unit(2), createdAt: '2026-07-01T00:00:00Z',
    });
    const { turnId: tieNew } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'tie new', embedding: unit(2), createdAt: '2026-07-02T00:00:00Z',
    });

    const rows = await semanticRecall(client, tenantA, agentA, acctA, unit(0));
    const ids = rows.map((r) => r.turn_id);
    expect(ids.indexOf(exact)).toBeLessThan(ids.indexOf(near));
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(orthogonal));
    expect(rows[0].similarity).toBeCloseTo(1, 5);

    // The tie pair share a distance — created_at DESC breaks it.
    expect(ids.indexOf(tieNew)).toBeLessThan(ids.indexOf(tieOld));
  });

  it('excludes provider/model-mismatched vectors from semantic; keyword still reaches them', async () => {
    const { turnId } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'space mismatch needle', embedding: unit(3),
      provider: 'voyage', model: 'voyage-4',
    });
    const semantic = await semanticRecall(client, tenantA, agentA, acctA, unit(3));
    expect(semantic.map((r) => r.turn_id)).not.toContain(turnId);

    const keyword = await keywordRecall(client, tenantA, agentA, acctA, 'space mismatch needle');
    expect(keyword.map((r) => r.turn_id)).toContain(turnId);
  });

  it('cross-sender and cross-tenant isolation hold on the semantic SQL', async () => {
    const { turnId: otherSender } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctB,
      userContent: 'isolation sender needle', embedding: unit(4),
    });
    const { turnId: otherTenant } = await seedEmbeddedTurn(client, {
      tenantId: tenantB, agentId: agentB, senderAccountId: acctA,
      userContent: 'isolation tenant needle', embedding: unit(4),
    });

    const rows = await semanticRecall(client, tenantA, agentA, acctA, unit(4));
    const ids = rows.map((r) => r.turn_id);
    expect(ids).not.toContain(otherSender);
    expect(ids).not.toContain(otherTenant);
  });

  it('excludeTurnId excludes; NULL-vector turns never appear in semantic results', async () => {
    const { turnId: excluded } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'exclusion probe', embedding: unit(5),
    });
    const { turnId: unembedded } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'null vector probe',
    });

    const rows = await semanticRecall(client, tenantA, agentA, acctA, unit(5), {
      excludeTurnId: excluded,
    });
    const ids = rows.map((r) => r.turn_id);
    expect(ids).not.toContain(excluded);
    expect(ids).not.toContain(unembedded);
  });

  it('preview windows around a literal substring hit and falls back to LEFT(200) otherwise', async () => {
    const padded = `${'x'.repeat(300)} preview-needle-here ${'y'.repeat(300)}`;
    const { turnId } = await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: padded, embedding: unit(6),
    });

    // Substring present → window centers near the needle.
    const hit = await semanticRecall(client, tenantA, agentA, acctA, unit(6), {
      rawLower: 'preview-needle-here',
    });
    const hitRow = hit.find((r) => r.turn_id === turnId);
    expect(hitRow).toBeDefined();
    const userPreview = hitRow!.messages.find((m) => m.role === 'user')!.preview;
    expect(userPreview).toContain('preview-needle-here');
    expect(userPreview.length).toBeLessThanOrEqual(200);

    // Substring absent → plain head, not a mis-windowed excerpt.
    const miss = await semanticRecall(client, tenantA, agentA, acctA, unit(6), {
      rawLower: 'zzz-not-present',
    });
    const missRow = miss.find((r) => r.turn_id === turnId);
    expect(missRow).toBeDefined();
    const missPreview = missRow!.messages.find((m) => m.role === 'user')!.preview;
    expect(missPreview).toBe(padded.slice(0, 200));
  });

  it('negative control: an orthogonal query still returns top-N rows with similarity ≈ 0', async () => {
    await seedEmbeddedTurn(client, {
      tenantId: tenantA, agentId: agentA, senderAccountId: acctA,
      userContent: 'negative control corpus', embedding: unit(7),
    });
    // Query along an axis no stored vector uses.
    const rows = await semanticRecall(client, tenantA, agentA, acctA, unit(700));
    expect(rows.length).toBeGreaterThan(0);
    // Documented pre-threshold behavior: weak matches DO return — with LOW
    // similarity. This assertion is the data motivating a future threshold.
    expect(Math.max(...rows.map((r) => Number(r.similarity)))).toBeLessThanOrEqual(0.001);
  });
});
