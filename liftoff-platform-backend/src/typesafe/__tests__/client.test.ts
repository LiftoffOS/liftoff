// `ask` over a mocked SDK client: the deadline, the retry rule, drift, and
// the usage row that is written whatever happens.

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  RateLimitError,
} from '@typesafe-ai/sdk';
import { ask, classifyAttemptFailure, _setTypeSafeClientFactoryForTesting } from '../client';
import { CLASSIFIER_SET } from '../questions';

jest.mock('../../infrastructure/secrets', () => ({ getTypeSafeApiKey: jest.fn().mockResolvedValue('key') }));
jest.mock('../usage', () => ({ recordTypeSafeUsage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { recordTypeSafeUsage } from '../usage';
import { getTypeSafeApiKey } from '../../infrastructure/secrets';

const OPTS = { deadlineMs: 500, attemptTimeoutMs: 200, maxRetries: 2, purpose: 'tool_classification', tenantId: 't1' };

function answers(model = CLASSIFIER_SET.model) {
  const yes = { type: 'choice', choice: 'no', confidence: 1, probabilities: { yes: 0.1, no: 0.9 } };
  return {
    model,
    usage: { input_tokens: 321, output_tokens: 7 },
    answers: {
      customerCommunication: yes, financialActions: yes, dataChanges: yes, externalPublishing: yes, hiringDecisions: yes,
      effect: { type: 'choice', choice: 'read', confidence: 1, probabilities: { read: 0.9, write: 0.05, destructive: 0.02, outbound: 0.02, unclear: 0.01 } },
    },
  };
}

/** A fake SDK client whose systemOne runs the given attempt script. */
function fakeClient(script: Array<() => Promise<unknown> | unknown>) {
  const systemOne = jest.fn((_req: unknown, _opts: unknown) => {
    const step = script.shift();
    const p = Promise.resolve().then(() => (step ? step() : Promise.reject(new Error('no script'))));
    return Object.assign(p, {
      withResponse: () => p.then((data) => ({ data, response: {} as Response, requestId: 'req_1' })),
    });
  });
  return { systemOne, __systemOne: systemOne } as unknown as import('@typesafe-ai/sdk').TypeSafeClient & { __systemOne: jest.Mock };
}

function connectFailure(code: string): APIConnectionError {
  const cause = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  return new APIConnectionError('fetch failed', { cause });
}

describe('ask', () => {
  let client: ReturnType<typeof fakeClient>;
  beforeEach(() => {
    jest.clearAllMocks();
    (getTypeSafeApiKey as jest.Mock).mockResolvedValue('key');
    (recordTypeSafeUsage as jest.Mock).mockResolvedValue(true);
  });
  afterEach(() => _setTypeSafeClientFactoryForTesting(null));

  it('success → the answers, the model, both token counts, one row', async () => {
    client = fakeClient([() => answers()]);
    _setTypeSafeClientFactoryForTesting(() => client);
    const r = await ask(CLASSIFIER_SET, { tool: { name: 'get', description: 'x' } }, OPTS);
    expect(r).not.toBeNull();
    expect(r!.model).toBe(CLASSIFIER_SET.model);
    expect(r!.usage).toEqual({ inputTokens: 321, outputTokens: 7 });
    expect(r!.attempts).toBe(1);
    expect(r!.vendorRequestId).toBe('req_1');
    expect(recordTypeSafeUsage).toHaveBeenCalledTimes(1);
    expect(recordTypeSafeUsage).toHaveBeenCalledWith(expect.objectContaining({
      attempts: 1, outcome: 'success', inputTokens: 321, outputTokens: 7, model: CLASSIFIER_SET.model, vendorRequestId: 'req_1',
      context: expect.objectContaining({ purpose: 'tool_classification', tenantId: 't1' }),
    }));
    // The SDK never retries; the model is the pinned id.
    const [req, opts] = client.__systemOne.mock.calls[0];
    expect((req as { model: string }).model).toBe(CLASSIFIER_SET.model);
    expect((opts as { retry: { maxRetries: number } }).retry).toEqual({ maxRetries: 0 });
    expect((opts as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('drift → usage recorded with the response counts, then null', async () => {
    client = fakeClient([() => answers('jev-9.9.9')]);
    _setTypeSafeClientFactoryForTesting(() => client);
    const r = await ask(CLASSIFIER_SET, {}, OPTS);
    expect(r).toBeNull();
    expect(recordTypeSafeUsage).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'drift', model: 'jev-9.9.9', inputTokens: 321, outputTokens: 7, error: expect.stringContaining('model_drift'),
    }));
  });

  it('a slow response past the deadline → null, attempts cancelled, one row with zero counts', async () => {
    client = fakeClient([
      () => new Promise((_, reject) => setTimeout(() => reject(new APITimeoutError(200)), 50)),
      () => answers(),
    ]);
    _setTypeSafeClientFactoryForTesting(() => client);
    const r = await ask(CLASSIFIER_SET, {}, { ...OPTS, deadlineMs: 120, attemptTimeoutMs: 200 });
    expect(r).toBeNull();
    // A timeout is ambiguous and is not re-sent.
    expect(client.__systemOne).toHaveBeenCalledTimes(1);
    expect(recordTypeSafeUsage).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'no_response', attempts: 1, inputTokens: 0, outputTokens: 0, error: expect.stringContaining('timeout'),
    }));
  });

  it('429 with a Retry-After beyond the deadline → null after one attempt', async () => {
    const err = new RateLimitError(429, {}, new Headers({ 'retry-after': '5' }));
    client = fakeClient([() => Promise.reject(err), () => answers()]);
    _setTypeSafeClientFactoryForTesting(() => client);
    const r = await ask(CLASSIFIER_SET, {}, { ...OPTS, deadlineMs: 300 });
    expect(r).toBeNull();
    expect(client.__systemOne).toHaveBeenCalledTimes(1);
    expect(recordTypeSafeUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'no_response', attempts: 1 }));
  });

  it('a connect failure is re-sent with the reference backoff; the row records both attempts', async () => {
    client = fakeClient([() => Promise.reject(connectFailure('ECONNREFUSED')), () => answers()]);
    _setTypeSafeClientFactoryForTesting(() => client);
    const r = await ask(CLASSIFIER_SET, {}, { ...OPTS, deadlineMs: 2_000 });
    expect(r).not.toBeNull();
    expect(r!.attempts).toBe(2);
    expect(client.__systemOne).toHaveBeenCalledTimes(2);
    expect(recordTypeSafeUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', attempts: 2 }));
  });

  it('a 503, a 529 and an interrupted body each end the call after one attempt', async () => {
    for (const err of [
      APIError.fromResponse(503, {}, new Headers()),
      APIError.fromResponse(529, {}, new Headers()),
      new APIConnectionError('socket hang up', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
    ]) {
      jest.clearAllMocks();
      client = fakeClient([() => Promise.reject(err), () => answers()]);
      _setTypeSafeClientFactoryForTesting(() => client);
      const r = await ask(CLASSIFIER_SET, {}, { ...OPTS, deadlineMs: 2_000 });
      expect(r).toBeNull();
      expect(client.__systemOne).toHaveBeenCalledTimes(1);
      expect(recordTypeSafeUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'no_response', attempts: 1 }));
    }
  });

  it('maxRetries bounds only the outer loop', async () => {
    client = fakeClient([
      () => Promise.reject(connectFailure('ENOTFOUND')),
      () => Promise.reject(connectFailure('ENOTFOUND')),
      () => Promise.reject(connectFailure('ENOTFOUND')),
      () => answers(),
    ]);
    _setTypeSafeClientFactoryForTesting(() => client);
    const r = await ask(CLASSIFIER_SET, {}, { ...OPTS, deadlineMs: 5_000, maxRetries: 2 });
    expect(r).toBeNull();
    expect(client.__systemOne).toHaveBeenCalledTimes(3);
  });

  it('a failed usage write → null, even on a served answer', async () => {
    client = fakeClient([() => answers()]);
    _setTypeSafeClientFactoryForTesting(() => client);
    (recordTypeSafeUsage as jest.Mock).mockResolvedValueOnce(false);
    const r = await ask(CLASSIFIER_SET, {}, OPTS);
    expect(r).toBeNull();
  });

  it('missing key or an unpinned threshold → no request and no row', async () => {
    client = fakeClient([() => answers()]);
    _setTypeSafeClientFactoryForTesting(() => client);
    (getTypeSafeApiKey as jest.Mock).mockResolvedValueOnce(null);
    expect(await ask(CLASSIFIER_SET, {}, OPTS)).toBeNull();
    const unpinned = { ...CLASSIFIER_SET, thresholds: { ...CLASSIFIER_SET.thresholds, INCLUDE_T: undefined } };
    expect(await ask(unpinned, {}, OPTS)).toBeNull();
    expect(client.__systemOne).not.toHaveBeenCalled();
    expect(recordTypeSafeUsage).not.toHaveBeenCalled();
  });

  it('a non-classification purpose without a tenant is refused before any request', async () => {
    client = fakeClient([() => answers()]);
    _setTypeSafeClientFactoryForTesting(() => client);
    expect(await ask(CLASSIFIER_SET, {}, { ...OPTS, purpose: 'distill_bind', tenantId: undefined })).toBeNull();
    expect(client.__systemOne).not.toHaveBeenCalled();
  });

  it('finalize sets the purpose and agent from the answer, on the one row', async () => {
    client = fakeClient([() => answers()]);
    _setTypeSafeClientFactoryForTesting(() => client);
    await ask(CLASSIFIER_SET, {}, { ...OPTS, purpose: 'route_message_none', finalize: () => ({ purpose: 'route_message', agentId: 'a1' }) });
    expect(recordTypeSafeUsage).toHaveBeenCalledTimes(1);
    expect(recordTypeSafeUsage).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ purpose: 'route_message', agentId: 'a1' }),
    }));
  });
});

describe('classifyAttemptFailure', () => {
  it('re-sends only on connect, TLS and 429', () => {
    expect(classifyAttemptFailure(connectFailure('ENOTFOUND'))).toEqual({ klass: 'connect_failure', retryable: true });
    expect(classifyAttemptFailure(connectFailure('ECONNREFUSED'))).toEqual({ klass: 'connect_failure', retryable: true });
    expect(classifyAttemptFailure(connectFailure('ERR_TLS_CERT_ALTNAME_INVALID'))).toEqual({ klass: 'tls_failure', retryable: true });
    expect(classifyAttemptFailure(new RateLimitError(429, {}, new Headers()))).toEqual({ klass: 'rate_limited', retryable: true });
    expect(classifyAttemptFailure(new APITimeoutError(100)).retryable).toBe(false);
    expect(classifyAttemptFailure(APIError.fromResponse(503, {}, new Headers())).retryable).toBe(false);
    expect(classifyAttemptFailure(APIError.fromResponse(529, {}, new Headers())).retryable).toBe(false);
    expect(classifyAttemptFailure(new APIConnectionError('reset', { cause: { code: 'ECONNRESET' } })).retryable).toBe(false);
    expect(classifyAttemptFailure(new Error('x')).retryable).toBe(false);
  });
});
