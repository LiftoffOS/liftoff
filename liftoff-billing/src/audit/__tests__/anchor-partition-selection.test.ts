import { PARTITION_FOR_DATE_SQL } from '../anchor-job';

// The original selection was `ORDER BY child DESC LIMIT 1`, which takes the
// lexicographically-largest partition name. Partitions are pre-created months
// ahead, so that is an empty future month — the anchor hashed nothing and
// reported success. These assertions pin the properties that made it wrong.
describe('PARTITION_FOR_DATE_SQL', () => {
  it('selects on the declared bounds, not on the name', () => {
    expect(PARTITION_FOR_DATE_SQL).not.toMatch(/ORDER BY\s+child/i);
    expect(PARTITION_FOR_DATE_SQL).toContain('relpartbound');
  });

  it('bounds the match on both ends, so a future partition cannot win', () => {
    expect(PARTITION_FOR_DATE_SQL).toMatch(/FROM[\s\S]*<=\s*\$1/);
    expect(PARTITION_FOR_DATE_SQL).toMatch(/TO[\s\S]*>\s*\$1/);
  });

  it('takes the date as a parameter rather than interpolating it', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain('$1');
  });

  it('excludes the DEFAULT partition', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("<> 'DEFAULT'");
  });

  it('scopes to billing_audit_log', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("p.relname = 'billing_audit_log'");
  });

  it('escapes the bound-parsing regex so it matches a literal paren', () => {
    expect(PARTITION_FOR_DATE_SQL).toContain("from 'FROM \\(''([0-9-]+)'");
    expect(PARTITION_FOR_DATE_SQL).toContain("from 'TO \\(''([0-9-]+)'");
  });
});
