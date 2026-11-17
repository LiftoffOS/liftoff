// RLS Integration Tests
// Phase 1: Verifies Row-Level Security policies against real Postgres
//
// These tests run against the Docker Compose Postgres instance
// (docker-compose.test.yml) with all migrations applied.
//
// Run: npm run test:integration

import {
  asTenant,
  asAdmin,
  getTestPool,
  closeTestPool,
  createTestTenant,
} from '../../test-utils/integration-helpers';

const TENANT_A_ID = '00000000-0000-0000-0000-00000000000a';
const TENANT_B_ID = '00000000-0000-0000-0000-00000000000b';
const ACCOUNT_A_ID = '00000000-0000-0000-0000-0000000000a1';
const ACCOUNT_B_ID = '00000000-0000-0000-0000-0000000000b1';

describe('Row-Level Security', () => {
  beforeAll(async () => {
    // Seed tenants and test data using admin scope (bypasses RLS)
    await asAdmin(async (client) => {
      // Create test accounts first (platform-global, no RLS)
      await client.query(
        `INSERT INTO accounts (id, firebase_uid, email, first_name, last_name)
         VALUES ($1, 'firebase_a', 'a@test.com', 'Alice', 'A'),
                ($2, 'firebase_b', 'b@test.com', 'Bob', 'B')
         ON CONFLICT (id) DO NOTHING`,
        [ACCOUNT_A_ID, ACCOUNT_B_ID],
      );

      await createTestTenant(client, { id: TENANT_A_ID, accountId: ACCOUNT_A_ID, name: 'Tenant A' });
      await createTestTenant(client, { id: TENANT_B_ID, accountId: ACCOUNT_B_ID, name: 'Tenant B' });

      // Create tenant members (has tenant_id → RLS applies)
      await client.query(
        `INSERT INTO tenant_members (tenant_id, account_id, role)
         VALUES ($1, $2, 'owner'), ($3, $4, 'owner')
         ON CONFLICT DO NOTHING`,
        [TENANT_A_ID, ACCOUNT_A_ID, TENANT_B_ID, ACCOUNT_B_ID],
      );

      // Create entitlements (has tenant_id → RLS applies)
      await client.query(
        `INSERT INTO entitlements (tenant_id, tenant_operational_status)
         VALUES ($1, 'active'), ($2, 'active')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [TENANT_A_ID, TENANT_B_ID],
      );
    });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('Tenant isolation — SELECT', () => {
    it('tenant A cannot SELECT tenant B rows from tenant_members', async () => {
      const rows = await asTenant(TENANT_A_ID, async (client) => {
        const result = await client.query('SELECT * FROM tenant_members');
        return result.rows;
      });

      // Should only see Tenant A's member, not Tenant B's
      expect(rows.length).toBe(1);
      expect(rows[0].tenant_id).toBe(TENANT_A_ID);
    });

    it('tenant B cannot SELECT tenant A rows from entitlements', async () => {
      const rows = await asTenant(TENANT_B_ID, async (client) => {
        const result = await client.query('SELECT * FROM entitlements');
        return result.rows;
      });

      expect(rows.length).toBe(1);
      expect(rows[0].tenant_id).toBe(TENANT_B_ID);
    });

    it('unscoped SELECT without WHERE still returns only own tenant rows', async () => {
      const rows = await asTenant(TENANT_A_ID, async (client) => {
        const result = await client.query('SELECT * FROM entitlements');
        return result.rows;
      });

      // Even without a WHERE clause, RLS filters to tenant A only
      expect(rows.every((r: any) => r.tenant_id === TENANT_A_ID)).toBe(true);
    });
  });

  describe('Tenant isolation — UPDATE/DELETE', () => {
    it('tenant A cannot UPDATE tenant B rows', async () => {
      // Tenant A tries to update Tenant B's entitlement
      const updatedCount = await asTenant(TENANT_A_ID, async (client) => {
        const result = await client.query(
          `UPDATE entitlements SET tenant_operational_status = 'suspended'
           WHERE tenant_id = $1 RETURNING *`,
          [TENANT_B_ID],
        );
        return result.rowCount;
      });

      expect(updatedCount).toBe(0);

      // Verify Tenant B's entitlement is unchanged
      const status = await asTenant(TENANT_B_ID, async (client) => {
        const result = await client.query('SELECT tenant_operational_status FROM entitlements');
        return result.rows[0]?.tenant_operational_status;
      });
      expect(status).toBe('active');
    });

    it('tenant A cannot DELETE tenant B rows', async () => {
      const deletedCount = await asTenant(TENANT_A_ID, async (client) => {
        const result = await client.query(
          'DELETE FROM tenant_members WHERE tenant_id = $1',
          [TENANT_B_ID],
        );
        return result.rowCount;
      });

      expect(deletedCount).toBe(0);
    });
  });

  describe('Missing tenant context', () => {
    it('throws error when app.current_tenant_id is not set', async () => {
      const pool = getTestPool();
      const client = await pool.connect();
      try {
        // Query without setting app.current_tenant_id should error
        // because current_setting() is called WITHOUT the silent `true` param
        await expect(
          client.query('SELECT * FROM tenant_members'),
        ).rejects.toThrow();
      } finally {
        client.release();
      }
    });
  });

  describe('Admin scope', () => {
    it('admin CAN read cross-tenant data', async () => {
      const rows = await asAdmin(async (client) => {
        const result = await client.query('SELECT * FROM tenant_members ORDER BY tenant_id');
        return result.rows;
      });

      // Admin should see both tenants' members
      const tenantIds = [...new Set(rows.map((r: any) => r.tenant_id))];
      expect(tenantIds).toContain(TENANT_A_ID);
      expect(tenantIds).toContain(TENANT_B_ID);
    });
  });

  describe('Connection pool safety', () => {
    it('tenant context does not leak between withTenantScope calls', async () => {
      // First call as Tenant A
      const rowsA = await asTenant(TENANT_A_ID, async (client) => {
        const result = await client.query('SELECT * FROM entitlements');
        return result.rows;
      });
      expect(rowsA.every((r: any) => r.tenant_id === TENANT_A_ID)).toBe(true);

      // Second call as Tenant B — should not see Tenant A's data
      const rowsB = await asTenant(TENANT_B_ID, async (client) => {
        const result = await client.query('SELECT * FROM entitlements');
        return result.rows;
      });
      expect(rowsB.every((r: any) => r.tenant_id === TENANT_B_ID)).toBe(true);
    });
  });
});
