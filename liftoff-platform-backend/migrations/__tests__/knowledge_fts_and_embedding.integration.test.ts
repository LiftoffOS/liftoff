// Knowledge full-text + embedding integration tests — exercises the public
// repo helpers (searchByTenantAndConnectors / countByTenantAndConnectors) end-
// to-end against the migrated schema. Covers:
//   - migration 230: search_tsv generated column, GIN index, scoping semantics
//   - migration 232: pgvector embedding column, HNSW index, RRF retrieval,
//                    and the invalidate-embedding-on-text-change trigger
//
// Picks up the .integration.test.ts suffix so it runs under
// jest.integration.config.js with all migrations applied.
//
// Run: npm run test:integration -- knowledge_fts_and_embedding

import { asAdmin, closeTestPool, createTestTenant } from '../../src/test-utils/integration-helpers';
import { closePools } from '../../src/infrastructure/database';
import {
  searchByTenantAndConnectors,
  countByTenantAndConnectors,
} from '../../src/knowledge/repository';

const TENANT_A_ID = '00000000-0000-0000-0000-0000000fb230';
const TENANT_B_ID = '00000000-0000-0000-0000-0000000fb231';
const ACCOUNT_A_ID = '00000000-0000-0000-0000-0000000fb232';
const ACCOUNT_B_ID = '00000000-0000-0000-0000-0000000fb233';
const CONNECTOR_X = '11111111-1111-1111-1111-111111111111';
const CONNECTOR_Y = '22222222-2222-2222-2222-222222222222';

async function seedTenants(): Promise<void> {
  await asAdmin(async (client) => {
    await client.query(
      `INSERT INTO accounts (id, firebase_uid, email, first_name, last_name) VALUES
         ($1, 'fb_230_a', '230a@test.com', 'A', 'A'),
         ($2, 'fb_230_b', '230b@test.com', 'B', 'B')
       ON CONFLICT (id) DO NOTHING`,
      [ACCOUNT_A_ID, ACCOUNT_B_ID],
    );
    await createTestTenant(client, { id: TENANT_A_ID, accountId: ACCOUNT_A_ID, name: 'FTS Tenant A' });
    await createTestTenant(client, { id: TENANT_B_ID, accountId: ACCOUNT_B_ID, name: 'FTS Tenant B' });
  });
}

async function wipeRows(): Promise<void> {
  await asAdmin(async (client) => {
    await client.query(`DELETE FROM knowledge_items WHERE tenant_id IN ($1, $2)`, [TENANT_A_ID, TENANT_B_ID]);
  });
}

async function insertRow(args: {
  tenantId: string;
  title: string;
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'error';
  connectorId?: string | null;
  excerpt?: string | null;
  extractedText?: string | null;
}): Promise<void> {
  await asAdmin(async (client) => {
    await client.query(
      `INSERT INTO knowledge_items
         (tenant_id, title, connector_id, excerpt, extracted_text, sync_status, content_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'article')`,
      [
        args.tenantId,
        args.title,
        args.connectorId ?? null,
        args.excerpt ?? null,
        args.extractedText ?? null,
        args.syncStatus ?? 'synced',
      ],
    );
  });
}

describe('Migration 230 — knowledge_items full-text search', () => {
  beforeAll(seedTenants);
  afterAll(async () => {
    // The test uses two pools:
    //   - the integration-helpers test pool (asAdmin / createTestTenant)
    //   - the production pool (repo helpers via withTenantScope / withAdminScope)
    // Both must end or Jest hangs on open handles.
    await closeTestPool();
    await closePools();
  });
  afterEach(wipeRows);

  describe('searchByTenantAndConnectors', () => {
    it('matches a title-only row (search_tsv covers title even when extracted_text is NULL)', async () => {
      await insertRow({ tenantId: TENANT_A_ID, title: 'Refund Policy', connectorId: CONNECTOR_X });

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'refund',
        5,
      );
      expect(results.map(r => r.title)).toContain('Refund Policy');
    });

    it('excludes rows with sync_status=error', async () => {
      await insertRow({ tenantId: TENANT_A_ID, title: 'Password Reset', connectorId: CONNECTOR_X, syncStatus: 'synced' });
      await insertRow({ tenantId: TENANT_A_ID, title: 'Password Recovery', connectorId: CONNECTOR_X, syncStatus: 'error' });

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'password',
        5,
      );
      const titles = results.map(r => r.title);
      expect(titles).toContain('Password Reset');
      expect(titles).not.toContain('Password Recovery');
    });

    it('enforces tenant isolation (tenant B row not returned for tenant A query)', async () => {
      await insertRow({ tenantId: TENANT_B_ID, title: 'Shared Word', connectorId: CONNECTOR_X });

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        true,
        'shared',
        5,
      );
      expect(results).toHaveLength(0);
    });

    it('scopes to the supplied connectorIds — connector Y row hidden when only X is requested', async () => {
      await insertRow({ tenantId: TENANT_A_ID, title: 'Visible', connectorId: CONNECTOR_X });
      await insertRow({ tenantId: TENANT_A_ID, title: 'Hidden', connectorId: CONNECTOR_Y });

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'visible OR hidden',
        5,
      );
      expect(results.map(r => r.title)).toEqual(['Visible']);
    });

    it('includeManual=true exposes connector_id IS NULL rows; false excludes them', async () => {
      await insertRow({ tenantId: TENANT_A_ID, title: 'Manual Import', connectorId: null });

      const withManual = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        true,
        'manual',
        5,
      );
      expect(withManual.map(r => r.title)).toContain('Manual Import');

      const withoutManual = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'manual',
        5,
      );
      expect(withoutManual.map(r => r.title)).not.toContain('Manual Import');
    });

    it('backfills excerpt via ts_headline when the native excerpt is empty', async () => {
      await insertRow({
        tenantId: TENANT_A_ID,
        title: 'Welcome',
        connectorId: CONNECTOR_X,
        excerpt: '',
        extractedText: 'Welcome to Liftoff. This document explains onboarding and refund policies for customers.',
      });

      const [hit] = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'onboarding',
        5,
      );
      expect(hit).toBeDefined();
      expect(hit.excerpt).toMatch(/<b>onboarding<\/b>/i);
    });
  });

  describe('RRF hybrid retrieval (migration 232 embedding column)', () => {
    // Build a unit-norm 1536-dim vector pointing along axis `i` so we can
    // hand-craft documents whose cosine distance to the query vector is
    // deterministic. Element `n` is 1 (or near-1), everything else zero.
    function axisVector(axis: number, dims = 1536): number[] {
      const v = new Array(dims).fill(0);
      v[axis] = 1;
      return v;
    }

    async function setEmbedding(itemTitle: string, vec: number[]): Promise<void> {
      await asAdmin(async (client) => {
        await client.query(
          `UPDATE knowledge_items
              SET embedding = $1::vector
            WHERE tenant_id = $2 AND title = $3`,
          [`[${vec.join(',')}]`, TENANT_A_ID, itemTitle],
        );
      });
    }

    it('skips the RRF branch entirely when queryEmbedding is omitted (BM25-only)', async () => {
      await insertRow({ tenantId: TENANT_A_ID, title: 'No Embed', connectorId: CONNECTOR_X, extractedText: 'Lorem' });

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'lorem',
        5,
      );
      expect(results.map(r => r.title)).toContain('No Embed');
    });

    it('returns vector-only matches even when BM25 finds nothing', async () => {
      // Document text has no overlap with the query — pure semantic match
      // proves the `vec` CTE is contributing to the RRF score.
      await insertRow({
        tenantId: TENANT_A_ID,
        title: 'Locked Out',
        connectorId: CONNECTOR_X,
        extractedText: 'Account access recovery steps for forgotten credentials.',
      });
      await setEmbedding('Locked Out', axisVector(7));

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'totally unrelated query',
        5,
        axisVector(7),
      );
      expect(results.map(r => r.title)).toContain('Locked Out');
    });

    it('respects connectorId scope inside the RRF branch (vector-only)', async () => {
      await insertRow({
        tenantId: TENANT_A_ID,
        title: 'X-scope',
        connectorId: CONNECTOR_X,
        extractedText: 'irrelevant body',
      });
      await insertRow({
        tenantId: TENANT_A_ID,
        title: 'Y-scope',
        connectorId: CONNECTOR_Y,
        extractedText: 'irrelevant body',
      });
      await setEmbedding('X-scope', axisVector(1));
      await setEmbedding('Y-scope', axisVector(1));

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'nope',
        5,
        axisVector(1),
      );
      const titles = results.map(r => r.title);
      expect(titles).toContain('X-scope');
      expect(titles).not.toContain('Y-scope');
    });

    it('prunes vector matches past the cosine-distance floor (0.7)', async () => {
      // Document embedded on axis 9, query embedded on axis 0. These are
      // orthogonal — cosine distance 1.0 — past the floor of 0.7. The row
      // also has zero text overlap with the query, so BM25 finds nothing.
      // Result: no hits, even though both branches *could* have returned
      // this row in a floor-less implementation.
      await insertRow({
        tenantId: TENANT_A_ID,
        title: 'Orthogonal',
        connectorId: CONNECTOR_X,
        extractedText: 'completely unrelated content',
      });
      await setEmbedding('Orthogonal', axisVector(9));

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        false,
        'nothing matches this',
        5,
        axisVector(0),
      );
      expect(results.map(r => r.title)).not.toContain('Orthogonal');
    });

    it('does not leak across tenants in the RRF branch', async () => {
      await insertRow({
        tenantId: TENANT_B_ID,
        title: 'B-secret',
        connectorId: CONNECTOR_X,
        extractedText: 'irrelevant',
      });
      // setEmbedding only writes under TENANT_A; for tenant B we go through
      // admin scope so the WHERE-tenant clause picks up the row.
      await asAdmin(async (client) => {
        await client.query(
          `UPDATE knowledge_items SET embedding = $1::vector WHERE tenant_id = $2 AND title = $3`,
          [`[${axisVector(2).join(',')}]`, TENANT_B_ID, 'B-secret'],
        );
      });

      const results = await searchByTenantAndConnectors(
        TENANT_A_ID,
        [CONNECTOR_X],
        true,
        'anything',
        5,
        axisVector(2),
      );
      expect(results.map(r => r.title)).not.toContain('B-secret');
    });
  });

  describe('migration 232 trigger — embedding invalidated on extracted_text change', () => {
    it('NULLs embedding when extracted_text is updated by the worker', async () => {
      // Seed a row with a known embedding, then change extracted_text.
      await insertRow({
        tenantId: TENANT_A_ID,
        title: 'Reset Trigger',
        connectorId: CONNECTOR_X,
        extractedText: 'original text',
      });
      await asAdmin(async (client) => {
        const onesVec = `[${new Array(1536).fill(0.1).join(',')}]`;
        await client.query(
          `UPDATE knowledge_items SET embedding = $1::vector WHERE tenant_id = $2 AND title = $3`,
          [onesVec, TENANT_A_ID, 'Reset Trigger'],
        );
        await client.query(
          `UPDATE knowledge_items SET extracted_text = 'new text' WHERE tenant_id = $1 AND title = $2`,
          [TENANT_A_ID, 'Reset Trigger'],
        );
        const r = await client.query<{ embedding: string | null }>(
          `SELECT embedding FROM knowledge_items WHERE tenant_id = $1 AND title = $2`,
          [TENANT_A_ID, 'Reset Trigger'],
        );
        expect(r.rows[0].embedding).toBeNull();
      });
    });

    it('preserves embedding when extracted_text does not change', async () => {
      await insertRow({
        tenantId: TENANT_A_ID,
        title: 'Keep Trigger',
        connectorId: CONNECTOR_X,
        extractedText: 'stable text',
      });
      await asAdmin(async (client) => {
        const vec = `[${new Array(1536).fill(0.2).join(',')}]`;
        await client.query(
          `UPDATE knowledge_items SET embedding = $1::vector WHERE tenant_id = $2 AND title = $3`,
          [vec, TENANT_A_ID, 'Keep Trigger'],
        );
        // Touch a different column — trigger only fires on extracted_text changes.
        await client.query(
          `UPDATE knowledge_items SET title = 'Keep Trigger Renamed' WHERE tenant_id = $1 AND title = $2`,
          [TENANT_A_ID, 'Keep Trigger'],
        );
        const r = await client.query<{ embedding: string | null }>(
          `SELECT embedding FROM knowledge_items WHERE tenant_id = $1 AND title = 'Keep Trigger Renamed'`,
          [TENANT_A_ID],
        );
        expect(r.rows[0].embedding).not.toBeNull();
      });
    });
  });

  describe('countByTenantAndConnectors', () => {
    it('returns 0 when no rows exist for the tenant + connector list', async () => {
      const n = await countByTenantAndConnectors(TENANT_A_ID, [CONNECTOR_X], true);
      expect(n).toBe(0);
    });

    it('counts only synced rows scoped to the supplied connectorIds', async () => {
      await insertRow({ tenantId: TENANT_A_ID, title: 'Synced 1', connectorId: CONNECTOR_X });
      await insertRow({ tenantId: TENANT_A_ID, title: 'Synced 2', connectorId: CONNECTOR_X });
      await insertRow({ tenantId: TENANT_A_ID, title: 'Synced 3', connectorId: CONNECTOR_Y });
      await insertRow({ tenantId: TENANT_A_ID, title: 'Errored', connectorId: CONNECTOR_X, syncStatus: 'error' });
      await insertRow({ tenantId: TENANT_A_ID, title: 'Manual', connectorId: null });

      expect(await countByTenantAndConnectors(TENANT_A_ID, [CONNECTOR_X], false)).toBe(2);
      expect(await countByTenantAndConnectors(TENANT_A_ID, [CONNECTOR_X], true)).toBe(3);
      expect(await countByTenantAndConnectors(TENANT_A_ID, [CONNECTOR_X, CONNECTOR_Y], false)).toBe(3);
    });

    it('does not leak across tenants', async () => {
      await insertRow({ tenantId: TENANT_B_ID, title: 'B-only', connectorId: CONNECTOR_X });
      expect(await countByTenantAndConnectors(TENANT_A_ID, [CONNECTOR_X], true)).toBe(0);
    });
  });
});
