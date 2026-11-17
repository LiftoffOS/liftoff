// Memory metrics: accumulator semantics + log emission shape.

jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import { log } from '../../infrastructure/logging';
import { incCounter, observeHistogram, setGauge } from '../metrics';

describe('memory metrics', () => {
  beforeEach(() => {
    (log.info as jest.Mock).mockClear();
  });

  it('incCounter emits a structured log line with metric_name + metric_value', () => {
    incCounter('embedding_cache_hit_total', { __name: 'embedding_cache_hit_total', model: 'text-embedding-004' });
    const call = (log.info as jest.Mock).mock.calls[0];
    expect(call[0]).toMatchObject({
      metric_type: 'counter',
      metric_name: 'embedding_cache_hit_total',
      metric_value: 1,
      model: 'text-embedding-004',
    });
  });

  it('observeHistogram emits with the observed value', () => {
    // tenant_id is a forbidden label; normalizeMetricLabels drops it before the
    // accumulator or the log line ever sees it.
    observeHistogram('memory_summary_group_size', 7, { tenant_id: 't1', tier: 'l1' });
    const call = (log.info as jest.Mock).mock.calls[0];
    expect(call[0]).toMatchObject({
      metric_type: 'histogram',
      metric_name: 'memory_summary_group_size',
      metric_value: 7,
      tier: 'l1',
    });
    expect(call[0]).not.toHaveProperty('tenant_id');
  });

  it('setGauge emits with the gauge value', () => {
    setGauge('graduation_lag_seconds', 604800, { tenant_id: 't1', layer: 'role' });
    const call = (log.info as jest.Mock).mock.calls[0];
    expect(call[0]).toMatchObject({
      metric_type: 'gauge',
      metric_name: 'graduation_lag_seconds',
      metric_value: 604800,
    });
  });
});
