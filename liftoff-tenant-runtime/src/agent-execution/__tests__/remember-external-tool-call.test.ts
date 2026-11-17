// One function remembers a call the gateway did not dispatch — the ledger row
// and the provenance record — so the three stream seams and the bridge cannot
// drift from each other, and so the bridge can WAIT for it.

jest.mock('../../action-ledger/record-external-tool-call', () => ({
  recordExternalToolCall: jest.fn(async () => 'recorded'),
}));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: () => ({ observeExternal: observeExternalMock }),
}));
const observeExternalMock = jest.fn(async () => true);

import { rememberExternalToolCall, _clearPendingRetriesForTesting, _pendingRetryCountForTesting } from '../remember-external-tool-call';
import { recordExternalToolCall } from '../../action-ledger/record-external-tool-call';

const catalog = {
  tools: [
    { name: 'google-mail-0105297e__create_draft', serverId: 'liftoff-tool-gateway' },
    { name: 'github-dd4c4689__pull_request_read', serverId: 'github-dd4c4689' },
  ],
};
const base = { catalog, tenantId: 't', agentId: 'a', invocationId: 'inv', callId: 'c1', result: { content: [] } };

beforeEach(() => {
  (recordExternalToolCall as jest.Mock).mockReset().mockResolvedValue('recorded');
  observeExternalMock.mockReset().mockResolvedValue(true);
  _clearPendingRetriesForTesting();
});
afterAll(() => _clearPendingRetriesForTesting());

it('records and observes a vendor call under its SDK-form name, with the arguments the tool received', async () => {
  await rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: { pullNumber: 1 } });
  expect(recordExternalToolCall).toHaveBeenCalledWith(expect.objectContaining({
    toolName: 'mcp__github-dd4c4689__pull_request_read', input: { pullNumber: 1 }, callId: 'c1',
  }));
  expect(observeExternalMock).toHaveBeenCalledWith(expect.objectContaining({
    toolName: 'mcp__github-dd4c4689__pull_request_read', input: { pullNumber: 1 },
  }));
});

it('does nothing for one of our own gateway tools — the gateway remembered it', async () => {
  await rememberExternalToolCall({ ...base, toolName: 'google-mail-0105297e__create_draft', args: {} });
  expect(recordExternalToolCall).not.toHaveBeenCalled();
  expect(observeExternalMock).not.toHaveBeenCalled();
});

it('resolves only once both records have — that is what the bridge waits for', async () => {
  let releaseObserve!: () => void;
  observeExternalMock.mockImplementationOnce(() => new Promise<void>((r) => { releaseObserve = r; }));
  let done = false;
  const p = rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: {} }).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 10));
  expect(done).toBe(false);
  releaseObserve();
  await p;
  expect(done).toBe(true);
});

it('says so when the record failed, and never throws', async () => {
  observeExternalMock.mockImplementationOnce(async () => { throw new Error('gateway down'); });
  await expect(rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: {} })).resolves.toBe('failed');
});

it('says so when the record did not land in time, and does not wait forever', async () => {
  // The call proceeds — availability over enforcement, by choice — and the
  // outcome says the store may not have it yet, so the caller must NOT mark
  // the call as remembered.
  const { remembered } = jest.requireActual<typeof import('../remember-external-tool-call')>('../remember-external-tool-call');
  process.env.EXTERNAL_CALL_REMEMBER_TIMEOUT_MS = '20';
  observeExternalMock.mockImplementationOnce(() => new Promise<void>(() => undefined));
  try {
    const outcome = await rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: {} });
    expect(outcome).toBe('timed_out');
    expect(remembered(outcome)).toBe(false);
    expect(remembered('recorded')).toBe(true);
    expect(remembered('skipped')).toBe(true);
  } finally {
    delete process.env.EXTERNAL_CALL_REMEMBER_TIMEOUT_MS;
  }
});

it('reports a recorded call as recorded, and a gateway tool as skipped', async () => {
  await expect(rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: {} })).resolves.toBe('recorded');
  await expect(rememberExternalToolCall({ ...base, toolName: 'google-mail-0105297e__create_draft', args: {} })).resolves.toBe('skipped');
});

it('with no engine call id, records provenance only — the ledger row needs the id, and the stream will write it', async () => {
  const { callId: _omit, ...uncorrelated } = base;
  await expect(rememberExternalToolCall({ ...uncorrelated, toolName: 'github-dd4c4689__pull_request_read', args: {} })).resolves.toBe('recorded');
  expect(recordExternalToolCall).not.toHaveBeenCalled();
  expect(observeExternalMock).toHaveBeenCalledTimes(1);
});

describe('the outcome is only as true as the writers', () => {
  // The writers are non-throwing by design; a caller that read a resolved
  // promise as a written row marked calls remembered that no row existed for.
  it('a ledger row the database refused is not "recorded"', async () => {
    (recordExternalToolCall as jest.Mock).mockResolvedValueOnce('failed');
    await expect(rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: {} })).resolves.toBe('failed');
  });

  it('a provenance record the gateway could not take is not "recorded"', async () => {
    observeExternalMock.mockResolvedValueOnce(false);
    await expect(rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: {} })).resolves.toBe('failed');
  });
});

describe('a provenance record that did not land is retried with the RAW data', () => {
  // The stream's fallback carries the framed result, which the id readers
  // cannot see into; only the copy handed to the observer can establish what
  // a read returned, so it is kept for the retry.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries the same raw result until it lands, then stops', async () => {
    const raw = { content: [{ type: 'text', text: '{"number":123}' }] };
    observeExternalMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const outcome = await rememberExternalToolCall({ ...base, result: raw, toolName: 'github-dd4c4689__pull_request_read', args: { pullNumber: 123 } });
    expect(outcome).toBe('failed');
    expect(_pendingRetryCountForTesting()).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(observeExternalMock).toHaveBeenCalledTimes(3);
    for (const call of observeExternalMock.mock.calls as unknown as Array<[{ result: unknown; toolName: string }]>) {
      expect(call[0].result).toBe(raw);
      expect(call[0].toolName).toBe('mcp__github-dd4c4689__pull_request_read');
    }
    expect(_pendingRetryCountForTesting()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(observeExternalMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after its attempts, and says so', async () => {
    observeExternalMock.mockResolvedValue(false);
    await rememberExternalToolCall({ ...base, toolName: 'github-dd4c4689__pull_request_read', args: {} });
    await jest.advanceTimersByTimeAsync(1_000 + 5_000 + 25_000 + 1);
    expect(observeExternalMock).toHaveBeenCalledTimes(1 + 3);
    expect(_pendingRetryCountForTesting()).toBe(0);
  });

  it('a record that THREW is retried too — a transport error is a record that did not land', async () => {
    // `ServiceClient` answers a non-2xx with a Response the client turns into
    // a throw, and a network error throws outright. Both used to log and
    // return `failed` with no retry, while the write-up said every failed raw
    // record was retried; the stream's copy cannot redo it.
    const raw = { content: [{ type: 'text', text: '{"number":123}' }] };
    observeExternalMock.mockRejectedValueOnce(new Error('tool-gateway observeExternal failed: HTTP 503')).mockResolvedValueOnce(true);
    const outcome = await rememberExternalToolCall({ ...base, result: raw, toolName: 'github-dd4c4689__pull_request_read', args: {} });
    expect(outcome).toBe('failed');
    expect(_pendingRetryCountForTesting()).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(observeExternalMock).toHaveBeenCalledTimes(2);
    expect((observeExternalMock.mock.calls[1] as unknown as [{ result: unknown }])[0].result).toBe(raw);
    expect(_pendingRetryCountForTesting()).toBe(0);
  });

  it('a call of our own gateway\'s is never retried — there was nothing to record', async () => {
    await rememberExternalToolCall({ ...base, toolName: 'google-mail-0105297e__create_draft', args: {} });
    expect(_pendingRetryCountForTesting()).toBe(0);
  });
});
