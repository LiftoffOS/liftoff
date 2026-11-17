import { withSpan, createSpan, endSpan, getCurrentTraceId, getTracer } from './tracing.js';

// These tests exercise the OTel API without initialising the SDK. OTel API
// methods are a no-op when no SDK is registered, which is exactly what we
// want in unit tests — we just want to verify the helpers don't throw.

describe('telemetry/tracing helpers', () => {
  it('createSpan returns a span with attributes set from TraceContext', () => {
    const span = createSpan('test-service', 'test-op', {
      tenantId: 'tenant-abc',
      agentId: 'agent-xyz',
      workflowId: 'wf-1',
      taskId: 'task-1',
      actionId: 'action-1',
      traceId: 'tr-1',
    });
    expect(span).toBeDefined();
    expect(typeof span.setAttribute).toBe('function');
    endSpan(span);
  });

  it('withSpan returns fn result on success', async () => {
    const result = await withSpan('svc', 'op', undefined, async () => 123);
    expect(result).toBe(123);
  });

  it('withSpan rethrows and records the error', async () => {
    const err = new Error('boom');
    await expect(
      withSpan('svc', 'op', undefined, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it('getCurrentTraceId returns undefined when no active span', () => {
    // OTel default is a no-op tracer → no active span → undefined.
    expect(getCurrentTraceId()).toBeUndefined();
  });

  it('getTracer returns a tracer with startSpan', () => {
    const tracer = getTracer('svc');
    expect(typeof tracer.startSpan).toBe('function');
  });
});
