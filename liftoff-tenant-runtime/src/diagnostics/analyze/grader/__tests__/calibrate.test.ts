import { pearson, spearman, meanAbsError } from '../calibrate';

describe('calibration statistics (null-safe)', () => {
  it('pearson is 1 for a perfect positive linear relation', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])!).toBeCloseTo(1);
  });
  it('returns null for n<2 and for a constant vector (undefined correlation, not NaN)', () => {
    expect(pearson([1], [1])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1], [1])).toBeNull();
    expect(spearman([5, 5, 5], [1, 2, 3])).toBeNull();
  });
  it('spearman is 1 for a monotonic (non-linear) relation', () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])!).toBeCloseTo(1);
  });
  it('mae computes the mean absolute error, null on empty', () => {
    expect(meanAbsError([10, 20], [12, 16])).toBeCloseTo(3);
    expect(meanAbsError([], [])).toBeNull();
  });
});
