import {
  applyWarehouseGuard,
  assertReadOnly,
  ReadOnlyViolationError,
} from '../warehouse-query-guardrails';

describe('warehouse-query-guardrails (TR sister-gate, plan §3D)', () => {
  describe('assertReadOnly — allows reads', () => {
    it('plain SELECT', () => {
      expect(() => assertReadOnly('SELECT id, name FROM users', 'postgresql')).not.toThrow();
    });
    it('SELECT with JOIN + WHERE', () => {
      expect(() =>
        assertReadOnly('SELECT u.id FROM users u JOIN orders o ON o.uid = u.id WHERE u.active', 'postgresql'),
      ).not.toThrow();
    });
    it('read-only CTE', () => {
      expect(() =>
        assertReadOnly('WITH a AS (SELECT id FROM users) SELECT * FROM a', 'postgresql'),
      ).not.toThrow();
    });
  });

  describe('assertReadOnly — rejects writes (fail-closed)', () => {
    const bad: Array<[string, string]> = [
      ['INSERT', "INSERT INTO users (name) VALUES ('x')"],
      ['UPDATE', "UPDATE users SET name = 'x' WHERE id = 1"],
      ['DELETE', 'DELETE FROM users WHERE id = 1'],
      ['DROP', 'DROP TABLE users'],
      ['TRUNCATE', 'TRUNCATE users'],
      ['multi-statement', 'SELECT 1; DELETE FROM users'],
      ['SELECT INTO', 'SELECT * INTO backup FROM users'],
      ['garbage', 'not sql at all !!!'],
      ['empty', ''],
    ];
    it.each(bad)('rejects %s', (_label, sql) => {
      expect(() => assertReadOnly(sql, 'postgresql')).toThrow(ReadOnlyViolationError);
    });
  });

  describe('applyWarehouseGuard', () => {
    it('passes non-warehouse tools through untouched', () => {
      const args = { to: 'a@b.com', body: 'hi' };
      expect(applyWarehouseGuard('gmail.send_email', args)).toBe(args);
    });

    it('row-caps a valid supabase.run_query and re-passes the gate', () => {
      const out = applyWarehouseGuard('supabase.run_query', { ref: 'proj', query: 'SELECT * FROM users' });
      expect(String(out.query)).toMatch(/_lo_capped LIMIT 1000/);
      // the capped SQL must itself still be a valid read
      expect(() => assertReadOnly(String(out.query), 'postgresql')).not.toThrow();
      expect(out.ref).toBe('proj'); // other args preserved
    });

    it('rejects a write on supabase.run_query', () => {
      expect(() =>
        applyWarehouseGuard('supabase.run_query', { ref: 'proj', query: 'DELETE FROM users' }),
      ).toThrow(ReadOnlyViolationError);
    });

    it('rejects a missing/blank SQL arg', () => {
      expect(() => applyWarehouseGuard('supabase.run_query', { ref: 'proj' })).toThrow(ReadOnlyViolationError);
    });
  });
});
