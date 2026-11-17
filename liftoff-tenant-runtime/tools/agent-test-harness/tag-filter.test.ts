import { matchesTagFilter } from './tag-filter';

describe('matchesTagFilter (--tag CSV list)', () => {
  const tags = ['memory', 'web', 'delegation'];

  it('no --tag → matches everything', () => {
    expect(matchesTagFilter(tags, undefined)).toBe(true);
  });

  it('single tag present → matches', () => {
    expect(matchesTagFilter(tags, 'web')).toBe(true);
  });

  it('single tag absent → no match', () => {
    expect(matchesTagFilter(tags, 'failure-mode')).toBe(false);
  });

  it('CSV list → matches if ANY tag is present (the live-bug case)', () => {
    expect(matchesTagFilter(tags, 'memory,web,delegation,failure-mode')).toBe(true);
  });

  it('CSV list with none present → no match (runner would exit 2)', () => {
    expect(matchesTagFilter(tags, 'foo,bar,baz')).toBe(false);
  });

  it('scenario with no tags → never matches a filter', () => {
    expect(matchesTagFilter([], 'web')).toBe(false);
  });

  it('whitespace in CSV is trimmed', () => {
    expect(matchesTagFilter(tags, ' web , failure-mode ')).toBe(true);
  });
});
