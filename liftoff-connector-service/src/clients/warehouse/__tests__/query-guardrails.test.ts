import {
  assertReadOnly,
  enforceRowCap,
  ReadOnlyViolationError,
  DEFAULT_GUARDRAILS,
} from '../query-guardrails';

describe('assertReadOnly', () => {
  const ok = (sql: string, d: 'postgresql' | 'snowflake' | 'bigquery' = 'postgresql') =>
    expect(() => assertReadOnly(sql, d)).not.toThrow();
  const bad = (sql: string, d: 'postgresql' | 'snowflake' | 'bigquery' = 'postgresql') =>
    expect(() => assertReadOnly(sql, d)).toThrow(ReadOnlyViolationError);

  it('allows a plain SELECT', () => ok('SELECT id, name FROM accounts WHERE active = true'));
  it('allows a read-only CTE', () => ok('WITH a AS (SELECT 1 AS x) SELECT * FROM a'));
  it('allows SELECT with an existing LIMIT', () => ok('SELECT * FROM t LIMIT 10'));
  it('allows a join + aggregate read', () =>
    ok('SELECT c.id, COUNT(*) FROM c JOIN o ON o.cid = c.id GROUP BY c.id'));

  it('rejects INSERT', () => bad('INSERT INTO t (a) VALUES (1)'));
  it('rejects UPDATE', () => bad('UPDATE t SET a = 1'));
  it('rejects DELETE', () => bad('DELETE FROM t'));
  it('rejects DROP', () => bad('DROP TABLE t'));
  it('rejects CREATE', () => bad('CREATE TABLE t (a int)'));
  it('rejects ALTER', () => bad('ALTER TABLE t ADD COLUMN b int'));
  it('rejects TRUNCATE', () => bad('TRUNCATE t'));
  it('rejects multiple statements', () => bad('SELECT 1; DROP TABLE t'));
  it('rejects SELECT ... INTO (table materialisation)', () => bad('SELECT * INTO newt FROM t'));
  it('rejects a data-modifying CTE (fail-closed parse)', () =>
    bad('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'));
  it('rejects COPY (fail-closed parse)', () => bad('COPY t TO STDOUT'));
  it('rejects unparseable garbage (fail-closed)', () => bad('not a query at all ;;;'));
  it('rejects empty input (fail-closed)', () => bad(''));

  it('validates in the snowflake dialect', () => {
    ok('SELECT current_timestamp()', 'snowflake');
    bad('DELETE FROM t', 'snowflake');
  });
  it('validates in the bigquery dialect', () => {
    ok('SELECT 1', 'bigquery');
    bad('DROP TABLE t', 'bigquery');
  });
});

describe('enforceRowCap', () => {
  it('wraps a query with an outer LIMIT', () => {
    const capped = enforceRowCap('SELECT * FROM t', 500);
    expect(capped).toContain('LIMIT 500');
    expect(capped).toContain('SELECT * FROM t');
  });
  it('strips a trailing semicolon before wrapping', () => {
    const capped = enforceRowCap('SELECT * FROM t;', 100);
    expect(capped).toContain('LIMIT 100');
    expect(capped).not.toMatch(/;\s*\)/);
  });
  it('output still parses as a read-only SELECT', () => {
    const capped = enforceRowCap('SELECT a FROM t WHERE a > 1', 50);
    expect(() => assertReadOnly(capped, 'postgresql')).not.toThrow();
  });
});

describe('DEFAULT_GUARDRAILS', () => {
  it('has a sane row cap and timeout', () => {
    expect(DEFAULT_GUARDRAILS.maxRows).toBeGreaterThan(0);
    expect(DEFAULT_GUARDRAILS.timeoutMs).toBeGreaterThan(0);
  });
});
