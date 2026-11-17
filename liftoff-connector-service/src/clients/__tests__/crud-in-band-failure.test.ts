// A write client that returns `{success: false}` must not be reported as a
// success.
//
// The CRUD clients have three ways to describe a write: `CreateResult`,
// `UpdateResult` and `DeleteResult`, and all three declare `success: boolean`
// plus an optional `error`. A client that cannot perform the write does not
// throw — it returns `{success: false, error}`.
//
// Both executor factories packed that struct into `ExecutorResult.result` as
// opaque JSON and returned nothing else, so `runConnectorExecution` stamped
// `success: true` over it. The failure survived only as a field inside a blob
// that nothing downstream read.
//
// For example, a Slack notification can come back
//   {"success":false,"id":"","error":"404 Connected account
//    \"ca_…\" not found", code:606,
//    slug:"ConnectedAccount_ResourceNotFound"}
// and be written to the audit log as `outcome: success`. The message reaches
// no channel. The agent is told it has been delivered, so nothing retries and
// nothing escalates, and the run completes clean.
//
// It is not Slack-specific — every REST connector registered through
// makeClientExecutor shares this seam.
import { crudFailure } from '../adapter';

describe('crudFailure', () => {
  it('catches the in-band failure payload', () => {
    const raw = {
      success: false,
      id: '',
      error: '404 {"error":{"message":"Connected account \\"ca_yF95RDfiz2ag\\" not found",'
        + '"code":606,"slug":"ConnectedAccount_ResourceNotFound","status":404}}',
    };
    expect(crudFailure('create', raw)?.message).toContain('ConnectedAccount_ResourceNotFound');
  });

  it('applies to every write op', () => {
    expect(crudFailure('create', { success: false, error: 'no' })).toBeDefined();
    expect(crudFailure('update', { success: false, error: 'no' })).toBeDefined();
    expect(crudFailure('delete', { success: false, error: 'no' })).toBeDefined();
  });

  it('lets a successful write through untouched', () => {
    expect(crudFailure('create', { success: true, id: 'C123' })).toBeUndefined();
    expect(crudFailure('update', { success: true })).toBeUndefined();
  });

  // Reads declare no `success` field — ExternalRecord is {id, data, ...} and
  // ListResult is {records, hasMore, ...}. A record whose DATA happens to carry
  // `success: false` is data, not a transport failure, and inventing a failure
  // there would break every read that returns one.
  it('never fires on a read', () => {
    expect(crudFailure('read', { success: false, error: 'x' })).toBeUndefined();
    expect(crudFailure('read', { id: '1', data: { success: false } })).toBeUndefined();
  });

  it('treats silence as success, not failure', () => {
    // A client whose result shape predates the flag says nothing about success.
    // Defaulting that to failure would break every one of them at once.
    expect(crudFailure('create', { id: 'C123' })).toBeUndefined();
    expect(crudFailure('create', { success: undefined })).toBeUndefined();
    expect(crudFailure('create', {})).toBeUndefined();
  });

  it('requires an explicit false, not merely a falsy value', () => {
    // `success: 0` or `success: ''` is a client bug, not a stated failure, and
    // guessing which it meant is how a working connector starts erroring.
    expect(crudFailure('create', { success: 0 })).toBeUndefined();
    expect(crudFailure('create', { success: '' })).toBeUndefined();
    expect(crudFailure('create', { success: null })).toBeUndefined();
  });

  it('still reports a failure that carries no error text', () => {
    // success:false with no message is still a failure. Saying so beats
    // reporting the write as delivered.
    const f = crudFailure('delete', { success: false });
    expect(f).toBeDefined();
    expect(f!.message).toContain('success=false');
  });

  it('survives a non-object result', () => {
    expect(crudFailure('create', null)).toBeUndefined();
    expect(crudFailure('create', undefined)).toBeUndefined();
    expect(crudFailure('create', 'ok')).toBeUndefined();
  });
});
