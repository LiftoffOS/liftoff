import { PARTITION_FOR_DATE_SQL } from '../audit/anchor-job';

describe('PARTITION_FOR_DATE_SQL', () => {
  it('selects on the declared bounds, not on the partition name', () => {
    // Selecting by name picks the newest pre-created month, which is empty and
    // in the future — the anchor would hash nothing and report success.
    expect(PARTITION_FOR_DATE_SQL).not.toMatch(/ORDER BY\s+(child|c\.relname)/i);
    expect(PARTITION_FOR_DATE_SQL).toContain('relpartbound');
  });

  it('bounds the match at both ends so exactly one partition can match', () => {
    expect(PARTITION_FOR_DATE_SQL).toMatch(/FROM[\s\S]*<=\s*\$1/);
    expect(PARTITION_FOR_DATE_SQL).toMatch(/TO[\s\S]*>\s*\$1/);
  });

  it('is naming-independent, which this table needs', () => {
    // Migration 009 renamed the parent but not the children, so the live table
    // carries both byok_usage_log_y2026_* and developer_proxy_usage_log_y2027_*.
    expect(PARTITION_FOR_DATE_SQL).not.toContain('byok_usage_log_y');
    expect(PARTITION_FOR_DATE_SQL).not.toContain('developer_proxy_usage_log_y');
  });

  it('scopes to the usage log parent', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("p.relname = 'developer_proxy_usage_log'");
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
