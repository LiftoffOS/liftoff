// The runtime's `ask`: the SDK is constructed with maxRetries 0; retry and
// backoff on a connect failure and on a 429 only; a 503, a 529, a timeout and
// an interrupted body each end the call with one attempt recorded and no
// second request; the per-request timeout and the deadline; one usage record
// per logical call with `attempts` set, acknowledged before the answer is
// returned; a failed post → null.

import { APIConnectionError, APIError, APITimeoutError, RateLimitError } from '@typesafe-ai/sdk';

jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({ resolveInternalAgentId: jest.fn().mockResolvedValue('internal-1') }));
jest.mock('../../integrations/web-fetch/web-tool-secrets', () => ({ getWebToolSecret: jest.fn().mockResolvedValue('key') }));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn() }));

import { ask, classifyAttemptFailure, _setTypeSafeClientFactoryForTesting, _setTypeSafeKeyReaderForTesting, _setUsagePosterForTesting } from '../client';
import { BROWSER_GOAL_CHECK_SET } from '../questions';

const posted: unknown[] = [];
let postOk = true;
const order: string[] = [];

function answers(model = BROWSER_GOAL_CHECK_SET.model) {
  return { model, usage: { input_tokens: 50, output_tokens: 3 }, answers: { goal_met: { type: 'noul', noul: 0.9 } } };
}
function fakeClient(script: Array<() => unknown>) {
  const systemOne = jest.fn((_req: unknown, opts: { retry?: { maxRetries: number }; timeout?: number; signal?: AbortSignal }) => {
    order.push('request');
    const step = script.shift();
    const p = Promise.resolve().then(() => (step ? step() : Promise.reject(new Error('no script'))));
    (systemOne as unknown as { lastOpts: unknown }).lastOpts = opts;
    return Object.assign(p, { withResponse: () => p.then((data) => ({ data, response: {}, requestId: 'req_9' })) });
  });
  return { systemOne } as unknown as import('@typesafe-ai/sdk').TypeSafeClient & { systemOne: jest.Mock & { lastOpts: unknown } };
}
function connectFailure(code: string) {
  return new APIConnectionError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}
const OPTS = { deadlineMs: 5_000, tenantId: 't1', runtimeAgentId: 'ra1', invocationId: 'inv1' };

beforeEach(() => {
  jest.clearAllMocks();
  posted.length = 0; order.length = 0; postOk = true;
  _setTypeSafeKeyReaderForTesting(async () => 'key');
  _setUsagePosterForTesting(async (body) => { posted.push(body); order.push('post'); return postOk; });
});
afterAll(() => { _setTypeSafeClientFactoryForTesting(null); _setTypeSafeKeyReaderForTesting(null); _setUsagePosterForTesting(null); });

describe('ask (runtime)', () => {
  it('constructs the request with maxRetries 0, a per-request timeout, and the deadline as the signal', async () => {
    const c = fakeClient([() => answers()]);
    _setTypeSafeClientFactoryForTesting(() => c);
    const r = await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, { ...OPTS, attemptTimeoutMs: 1_000 });
    expect(r).not.toBeNull();
    const opts = c.systemOne.lastOpts as { retry: { maxRetries: number }; timeout: number; signal: AbortSignal };
    expect(opts.retry).toEqual({ maxRetries: 0 });
    expect(opts.timeout).toBe(1_000);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('one usage record per logical call with attempts, acknowledged before the answer is returned', async () => {
    _setTypeSafeClientFactoryForTesting(() => fakeClient([() => answers()]));
    const r = await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, OPTS);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      provider: 'typesafe', model: BROWSER_GOAL_CHECK_SET.model, setId: 'browser_goal_check', attempts: 1,
      inputTokens: 50, outputTokens: 3, tenantId: 't1', invocationId: 'inv1', agentId: 'internal-1', success: true, vendorRequestId: 'req_9',
    });
    expect(order).toEqual(['request', 'post']);
    expect(r!.callId).toBe((posted[0] as { callId: string }).callId);
  });

  it('a failed post → null even on a served answer', async () => {
    _setTypeSafeClientFactoryForTesting(() => fakeClient([() => answers()]));
    postOk = false;
    expect(await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, OPTS)).toBeNull();
    expect(posted).toHaveLength(1);
  });

  it('retries with backoff on a connect failure and on a 429 only', async () => {
    let c = fakeClient([() => Promise.reject(connectFailure('ECONNREFUSED')), () => answers()]);
    _setTypeSafeClientFactoryForTesting(() => c);
    let r = await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, OPTS);
    expect(r!.attempts).toBe(2);
    expect(c.systemOne).toHaveBeenCalledTimes(2);

    c = fakeClient([() => Promise.reject(new RateLimitError(429, {}, new Headers({ 'retry-after-ms': '10' }))), () => answers()]);
    _setTypeSafeClientFactoryForTesting(() => c);
    r = await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, OPTS);
    expect(r!.attempts).toBe(2);
  });

  it('a 503, a 529, a timeout and an interrupted body each end the call with one attempt and no second request', async () => {
    for (const err of [
      APIError.fromResponse(503, {}, new Headers()),
      APIError.fromResponse(529, {}, new Headers()),
      new APITimeoutError(1_000),
      new APIConnectionError('socket hang up', { cause: { code: 'ECONNRESET' } }),
    ]) {
      posted.length = 0;
      const c = fakeClient([() => Promise.reject(err), () => answers()]);
      _setTypeSafeClientFactoryForTesting(() => c);
      expect(await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, OPTS)).toBeNull();
      expect(c.systemOne).toHaveBeenCalledTimes(1);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ attempts: 1, success: false, inputTokens: 0, outputTokens: 0 });
    }
  });

  it('the deadline bounds the whole call: no time left → no request, no row', async () => {
    const c = fakeClient([() => answers()]);
    _setTypeSafeClientFactoryForTesting(() => c);
    expect(await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, { ...OPTS, deadlineMs: 0 })).toBeNull();
    expect(c.systemOne).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it('drift is recorded, then rejected; a missing key sends nothing', async () => {
    _setTypeSafeClientFactoryForTesting(() => fakeClient([() => answers('jev-0.0.1')]));
    expect(await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, OPTS)).toBeNull();
    expect(posted[0]).toMatchObject({ success: false, model: 'jev-0.0.1', error: expect.stringContaining('model_drift') });
    posted.length = 0;
    _setTypeSafeKeyReaderForTesting(async () => null);
    expect(await ask(BROWSER_GOAL_CHECK_SET, { goal: 'x' }, OPTS)).toBeNull();
    expect(posted).toHaveLength(0);
  });
});

describe('classifyAttemptFailure', () => {
  it('names the unserved outcomes', () => {
    expect(classifyAttemptFailure(connectFailure('ENOTFOUND')).retryable).toBe(true);
    expect(classifyAttemptFailure(connectFailure('ERR_TLS_CERT_ALTNAME_INVALID'))).toEqual({ klass: 'tls_failure', retryable: true });
    expect(classifyAttemptFailure(APIError.fromResponse(503, {}, new Headers())).retryable).toBe(false);
  });
});
