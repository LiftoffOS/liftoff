// The side channel, end to end at the gateway: what the guardrail lifts is what
// the surface can collect, exactly once.
//
// The property that matters is the one that was broken: a value lifted out of
// the model's copy must be RECOVERABLE. Before this, `extractEgressOnly`
// removed it and the guardrail logged its path, so "the model cannot see it"
// and "nobody can see it" were the same outcome.
import {
  recordHostDelivered,
  drainHostDelivered,
  _resetHostDeliveredForTesting,
} from '../host-delivered';

beforeEach(() => _resetHostDeliveredForTesting());

describe('the host-delivered side channel', () => {
  it('hands back what was lifted, for the invocation that lifted it', () => {
    recordHostDelivered({
      invocationId: 'inv-1',
      toolName: 'drive__get_file',
      fields: { 'data.downloadUrl': 'https://example.test/a' },
    });

    expect(drainHostDelivered('inv-1')).toEqual([
      { toolName: 'drive__get_file', fields: { 'data.downloadUrl': 'https://example.test/a' } },
    ]);
  });

  it('delivers once — a second drain is empty', () => {
    // Not a nicety. These are secret-shaped values; leaving them readable after
    // delivery would let a later frame in the same turn re-send an earlier
    // call's, and would keep them in memory with nothing waiting for them.
    recordHostDelivered({ invocationId: 'inv-1', toolName: 't', fields: { a: 1 } });
    expect(drainHostDelivered('inv-1')).toHaveLength(1);
    expect(drainHostDelivered('inv-1')).toEqual([]);
  });

  it('never pools two invocations together', () => {
    recordHostDelivered({ invocationId: 'inv-1', toolName: 't', fields: { a: 1 } });
    recordHostDelivered({ invocationId: 'inv-2', toolName: 't', fields: { b: 2 } });
    expect(drainHostDelivered('inv-1')).toEqual([{ toolName: 't', fields: { a: 1 } }]);
    expect(drainHostDelivered('inv-2')).toEqual([{ toolName: 't', fields: { b: 2 } }]);
  });

  it('drops a call with no invocation rather than pooling it under undefined', () => {
    recordHostDelivered({ invocationId: undefined, toolName: 't', fields: { a: 1 } });
    expect(drainHostDelivered(undefined)).toEqual([]);
  });

  it('records nothing when nothing was lifted', () => {
    recordHostDelivered({ invocationId: 'inv-1', toolName: 't', fields: {} });
    expect(drainHostDelivered('inv-1')).toEqual([]);
  });

  it('bounds one invocation, so a runaway turn cannot grow it without end', () => {
    for (let i = 0; i < 200; i++) {
      recordHostDelivered({ invocationId: 'inv-1', toolName: `t${i}`, fields: { a: i } });
    }
    expect(drainHostDelivered('inv-1').length).toBeLessThanOrEqual(50);
  });
});
