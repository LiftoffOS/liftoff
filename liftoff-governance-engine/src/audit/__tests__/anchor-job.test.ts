import { PARTITION_FOR_DATE_SQL } from '../anchor-job';

describe('PARTITION_FOR_DATE_SQL', () => {
  it('selects on the declared bounds, not on the partition name', () => {
    // Migration 001 pre-creates 18 months, so the largest name is an empty
    // future month — an anchor over it hashes nothing and reports success.
    expect(PARTITION_FOR_DATE_SQL).not.toMatch(/ORDER BY\s+(child|c\.relname)/i);
    expect(PARTITION_FOR_DATE_SQL).toContain('relpartbound');
  });

  it('bounds the match at both ends so exactly one partition can match', () => {
    expect(PARTITION_FOR_DATE_SQL).toMatch(/FROM[\s\S]*<=\s*\$1/);
    expect(PARTITION_FOR_DATE_SQL).toMatch(/TO[\s\S]*>\s*\$1/);
  });

  it('anchors the action ledger, which is the partitioned record', () => {
    // audit_logs is a plain table with no partitions to hash.
    expect(PARTITION_FOR_DATE_SQL).toContain("p.relname = 'actions'");
    expect(PARTITION_FOR_DATE_SQL).not.toContain('audit_logs');
  });

  it('excludes the DEFAULT partition', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("<> 'DEFAULT'");
  });

  it('parameterises the date', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain('$1');
  });

  it('emits a regex matching a literal paren', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("from 'FROM \\(''([0-9-]+)'");
    expect(PARTITION_FOR_DATE_SQL).toContain("from 'TO \\(''([0-9-]+)'");
  });
});
