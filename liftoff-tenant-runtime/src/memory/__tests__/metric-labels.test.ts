// A metric may only be sliced by what it declares.
//
// The startup assert is the load-bearing half: a per-tenant label does not just
// make a metric unqueryable, it grows incCounter's process-local accumulator for
// the life of the instance. That is a leak nobody notices until an instance
// starts OOMing, long after the change that caused it.

import {
  METRIC_LABELS,
  FORBIDDEN_METRIC_LABELS,
  OTHER_LABEL_VALUE,
  assertMetricLabelDiscipline,
  normalizeMetricLabels,
} from '../metric-labels';

describe('assertMetricLabelDiscipline', () => {
  it('passes for the declarations we actually ship', () => {
    expect(() => assertMetricLabelDiscipline()).not.toThrow();
  });

  it('names every forbidden label the codebase has reached for', () => {
    for (const label of ['tenant_id', 'agent_id', 'invocation_id', 'thread_id', 'session_id']) {
      expect(FORBIDDEN_METRIC_LABELS.has(label)).toBe(true);
    }
  });
});

describe('normalizeMetricLabels', () => {
  it('drops a forbidden label rather than keying the accumulator on it', () => {
    const out = normalizeMetricLabels('agent_trigger_skipped_total', {
      trigger_kind: 'cloud_task',
      reason: 'concurrent_execution',
      tenant_id: 'tenant-1',
      agent_id: 'agent-1',
    });
    expect(out).toEqual({ trigger_kind: 'cloud_task', reason: 'concurrent_execution' });
  });

  it('normalises a value outside the declared set to "other"', () => {
    const out = normalizeMetricLabels('agent_trigger_skipped_total', {
      trigger_kind: 'cloud_task',
      reason: 'something_nobody_declared',
    });
    expect(out.reason).toBe(OTHER_LABEL_VALUE);
    expect(out.trigger_kind).toBe('cloud_task');
  });

  it('leaves an open-valued label alone', () => {
    // model comes from the rate table and provider from the adapter list; both
    // are bounded by something outside this file, so neither declares a set.
    const out = normalizeMetricLabels('llm_unpriced_tokens_total', {
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
    expect(out).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
  });

  it('keeps __name, which duplicates the metric name and adds no cardinality', () => {
    const out = normalizeMetricLabels('memory_retrieval_by_source', {
      __name: 'memory_retrieval_by_source',
      source: 'semantic',
    });
    expect(out).toEqual({ __name: 'memory_retrieval_by_source', source: 'semantic' });
  });

  it('passes an UNDECLARED metric through untouched', () => {
    // Silently zeroing the labels of a metric somebody forgot to declare would
    // lose data with no signal, and the startup assert cannot see a metric that
    // exists only at a call site.
    const out = normalizeMetricLabels('not_declared_anywhere_total', { anything: 'goes' });
    expect(out).toEqual({ anything: 'goes' });
  });

  it('declares no forbidden label anywhere in the table', () => {
    for (const [metric, spec] of Object.entries(METRIC_LABELS)) {
      for (const label of spec.labels) {
        expect([metric, FORBIDDEN_METRIC_LABELS.has(label)]).toEqual([metric, false]);
      }
    }
  });
});
