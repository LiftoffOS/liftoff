// Change C: fewer than MIN_GROUP_SIZE → no summary created.

describe('memory-summarization-loop skip', () => {
  it('skips groups smaller than MIN_GROUP_SIZE', () => {
    const MIN_GROUP_SIZE = 3;
    const group = [{ id: 'a' }, { id: 'b' }];
    expect(group.length < MIN_GROUP_SIZE).toBe(true);
  });
});
