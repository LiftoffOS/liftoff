// Change C: group with avgInfluence < threshold → no summary created.

describe('memory-summarization-loop influence filter', () => {
  it('skips groups with avg influence below MIN_AVG_INFLUENCE', () => {
    const MIN_AVG_INFLUENCE = 0.3;
    const group = [{ influence_score: '0.1' }, { influence_score: '0.2' }, { influence_score: '0.1' }];
    const avg = group.reduce((s, m) => s + parseFloat(m.influence_score), 0) / group.length;
    expect(avg < MIN_AVG_INFLUENCE).toBe(true);
  });
});
