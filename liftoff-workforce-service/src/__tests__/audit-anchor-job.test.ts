import { PARTITION_FOR_DATE_SQL } from '../audit/anchor-job.js';

describe('PARTITION_FOR_DATE_SQL', () => {
  it('selects on the declared bounds, not on the partition name', () => {
    // By name picks the newest pre-created month — empty and in the future, so
    // the anchor would hash nothing and still report success.
    expect(PARTITION_FOR_DATE_SQL).not.toMatch(/ORDER BY\s+(child|c\.relname)/i);
    expect(PARTITION_FOR_DATE_SQL).toContain('relpartbound');
  });

  it('bounds the match at both ends so exactly one partition can match', () => {
    expect(PARTITION_FOR_DATE_SQL).toMatch(/FROM[\s\S]*<=\s*\$1/);
    expect(PARTITION_FOR_DATE_SQL).toMatch(/TO[\s\S]*>\s*\$1/);
  });

  it('is naming-independent across partman and hand-written partitions', () => {
    // partman names new months p20260801; migration 010 named them 2026_04.
    expect(PARTITION_FOR_DATE_SQL).not.toContain('_p20');
    expect(PARTITION_FOR_DATE_SQL).not.toMatch(/workforce_audit_log_\d/);
  });

  it('excludes the DEFAULT partition', () => {
    // partman created one; dropping or anchoring it would confuse the overflow
    // net with the month's record.
    expect(PARTITION_FOR_DATE_SQL).toContain("<> 'DEFAULT'");
  });

  it('scopes to workforce_audit_log', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("p.relname = 'workforce_audit_log'");
  });

  it('parameterises the date', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain('$1');
  });

  it('emits a regex matching a literal paren', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("from 'FROM \\(''([0-9-]+)'");
    expect(PARTITION_FOR_DATE_SQL).toContain("from 'TO \\(''([0-9-]+)'");
  });
});
