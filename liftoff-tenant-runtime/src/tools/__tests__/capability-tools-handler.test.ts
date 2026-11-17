// capability_search / run_capability standard-tool handlers: they call
// platform-backend's capability-first routes and return the vendor-hidden
// string. run passes the triggering user's account when present (tenant-key
// resolution), omits it on an autonomous run (platform-funded).

jest.mock('../../clients/platform-backend-client', () => {
  const actual = jest.requireActual('../../clients/platform-backend-client');
  return { ...actual, capabilitySearchViaBackend: jest.fn(), runCapabilityViaBackend: jest.fn(), runDatasetToolViaBackend: jest.fn() };
});
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { executeStandardTool, type StandardToolContext } from '../standard-tool-handler';
import { capabilitySearchViaBackend, runCapabilityViaBackend, runDatasetToolViaBackend } from '../../clients/platform-backend-client';
import { recordCapabilityApproval, capabilityApprovalKey } from '../../tool-gateway/capability-approval-signal';
import { _resetCapabilityWindows, closeCapabilityWindow, openCapabilityWindow } from '../../tool-gateway/capability-outcome-signal';

const mockSearch = capabilitySearchViaBackend as jest.MockedFunction<typeof capabilitySearchViaBackend>;
const mockRun = runCapabilityViaBackend as jest.MockedFunction<typeof runCapabilityViaBackend>;

const baseCtx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: {},
  integrations: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  _resetCapabilityWindows();
});

describe('capability_search handler', () => {
  it('calls platform-backend and returns the vendor-hidden rendering', async () => {
    mockSearch.mockResolvedValue('Ranked building blocks:\n- [Social media data] tiktok fetch (capabilityId: cap_x)');
    const res = await executeStandardTool(
      'capability_search',
      { operation: 'fetch', entity: 'posts', mode: 'public_data', targetSystem: 'TikTok' },
      baseCtx,
    );
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', operation: 'fetch', entity: 'posts', mode: 'public_data', targetSystem: 'tiktok' }),
    );
    expect(mockSearch.mock.calls[0][0]).not.toHaveProperty('accountId');
    expect(res).toEqual({ success: true, result: expect.stringContaining('capabilityId: cap_x') });
    expect((res?.result as string).toLowerCase()).not.toContain('tikhub');
  });

  // The same account run_capability executes on rides on the search, from the
  // turn's context, so the control plane judges vendors on the credential the
  // run would use. A model cannot supply it.
  it('passes the triggering account when a person drove the turn, never one from the payload', async () => {
    mockSearch.mockResolvedValue('ok');
    const ctx: StandardToolContext = { ...baseCtx, messageSenderAccountId: 'acct-9' };
    await executeStandardTool('capability_search', { operation: 'x', entity: 'y', mode: 'public_data', accountId: 'attacker' }, ctx);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', accountId: 'acct-9' }));
  });
});

// The step that opened a window reads the typed outcome of every run: a
// capability that ran AND answered counts, a handoff, a refusal and an empty
// answer do not. From the control plane's flags, never from the text.
describe('run_capability notes its outcome into the open capability window', () => {
  const ctx: StandardToolContext = { ...baseCtx, invocationId: 'inv-w' };

  it('a run that answered counts as useful', async () => {
    openCapabilityWindow('inv-w', 'step:s1');
    mockRun.mockResolvedValue({ ok: true, empty: false, text: '[{"a":1}]' });
    await executeStandardTool('run_capability', { capabilityId: 'cap_r.x', args: {} }, ctx);
    expect(closeCapabilityWindow('inv-w', 'step:s1')).toMatchObject({ capabilityRuns: 1, capabilitySuccesses: 1 });
  });

  it('a run that answered nothing is ok to the model and not useful to the step', async () => {
    openCapabilityWindow('inv-w', 'step:s1');
    mockRun.mockResolvedValue({ ok: true, empty: true, text: 'This capability did not return a result.' });
    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_r.x', args: {} }, ctx);
    expect(res.success).toBe(true);
    expect(closeCapabilityWindow('inv-w', 'step:s1')).toMatchObject({ capabilityRuns: 1, capabilitySuccesses: 0 });
  });

  it('a handoff reaches the model as a failed call carrying the next handle — no fabricated success, no retry here', async () => {
    openCapabilityWindow('inv-w', 'step:s1');
    const text = 'This capability did not return a result. The next best for the same need takes: keyword (string, required); call run_capability with capabilityId cap_r.next, mapping your values onto those argument names.';
    mockRun.mockResolvedValue({ ok: false, kind: 'handoff', text });
    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_r.first', args: { q: 'x' } }, ctx);
    expect(res).toEqual({ success: false, error: text });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(closeCapabilityWindow('inv-w', 'step:s1')).toMatchObject({ capabilityRuns: 1, capabilitySuccesses: 0 });
  });

  it('a transport failure is noted as a run that did not answer', async () => {
    openCapabilityWindow('inv-w', 'step:s1');
    mockRun.mockRejectedValue(new Error('HTTP 503'));
    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_r.x', args: {} }, ctx);
    expect(res.success).toBe(false);
    expect(closeCapabilityWindow('inv-w', 'step:s1')).toMatchObject({ capabilityRuns: 1, capabilitySuccesses: 0 });
  });
});

describe('run_capability handler', () => {
  it('rejects a missing capabilityId without calling the backend', async () => {
    const res = await executeStandardTool('run_capability', { args: {} }, baseCtx);
    expect(res?.success).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('passes the triggering account when a person drove the turn (tenant-key)', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: '{"items":[]}' });
    const ctx: StandardToolContext = { ...baseCtx, messageSenderAccountId: 'acct-9' };
    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: { q: 'x' } }, ctx);
    // A read (no armed approval) forwards approved=false.
    expect(mockRun).toHaveBeenCalledWith('tenant-1', 'acct-9', 'cap_abc', { q: 'x' }, false, undefined, expect.any(Object), undefined);
    expect(res).toEqual({ success: true, result: '{"items":[]}' });
  });

  it('omits the account on an autonomous run (platform-funded)', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'ok' });
    await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: {} }, baseCtx);
    expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_abc', {}, false, undefined, expect.any(Object), undefined);
  });

  it('forwards approved=true ONLY when the gate armed an approval for this exact call', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'done' });
    const ctx: StandardToolContext = { ...baseCtx, invocationId: 'inv-1' };
    const payload = { capabilityId: 'cap_w.make_call', args: { to: '+15551234567' } };
    // The gate records this on operator approval, keyed to the whole input.
    recordCapabilityApproval(capabilityApprovalKey('inv-1', payload));

    await executeStandardTool('run_capability', payload, ctx);
    expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_w.make_call', { to: '+15551234567' }, true, undefined, expect.any(Object), undefined);

    // Consumed once: a second identical call is NOT still approved.
    mockRun.mockClear();
    await executeStandardTool('run_capability', payload, ctx);
    expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_w.make_call', { to: '+15551234567' }, false, undefined, expect.any(Object), undefined);
  });

  it('does not forward approval to a DIFFERENT call than the one approved', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'done' });
    const ctx: StandardToolContext = { ...baseCtx, invocationId: 'inv-2' };
    recordCapabilityApproval(capabilityApprovalKey('inv-2', { capabilityId: 'cap_w.make_call', args: { to: '+1' } }));
    // A different args value → different key → not approved.
    await executeStandardTool('run_capability', { capabilityId: 'cap_w.make_call', args: { to: '+2' } }, ctx);
    expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_w.make_call', { to: '+2' }, false, undefined, expect.any(Object), undefined);
  });

  // The schema declares `args` as an object, but a model can carry the same
  // content as `arguments` — a JSON-encoded string, or an object. The call must
  // run with those arguments, not an empty set, and the approval for a write
  // stays keyed to the payload exactly as proposed.
  describe('arguments carried under `arguments` instead of `args`', () => {
    const email = { to: 'x@y.com', subject: 's', body: 'b' };

    it('parses a JSON-encoded `arguments` string into the capability args', async () => {
      mockRun.mockResolvedValue({ ok: true, empty: false, text: 'sent' });
      await executeStandardTool(
        'run_capability',
        { arguments: JSON.stringify(email), capabilityId: 'cap_r.lookup' },
        baseCtx,
      );
      expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_r.lookup', email, false, undefined, expect.any(Object), undefined);
    });

    it('accepts `arguments` as an object', async () => {
      mockRun.mockResolvedValue({ ok: true, empty: false, text: 'sent' });
      await executeStandardTool('run_capability', { arguments: email, capabilityId: 'cap_r.lookup' }, baseCtx);
      expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_r.lookup', email, false, undefined, expect.any(Object), undefined);
    });

    it('prefers the schema `args` when both are present', async () => {
      mockRun.mockResolvedValue({ ok: true, empty: false, text: 'sent' });
      await executeStandardTool(
        'run_capability',
        { args: { q: 'schema' }, arguments: JSON.stringify({ q: 'legacy' }), capabilityId: 'cap_r.lookup' },
        baseCtx,
      );
      expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_r.lookup', { q: 'schema' }, false, undefined, expect.any(Object), undefined);
    });

    it('reads no arguments from a string that is not a JSON object, rather than guessing', async () => {
      mockRun.mockResolvedValue({ ok: true, empty: false, text: 'sent' });
      await executeStandardTool('run_capability', { arguments: 'not json', capabilityId: 'cap_r.lookup' }, baseCtx);
      expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_r.lookup', {}, false, undefined, expect.any(Object), undefined);
    });

    it('reads a flattened shape — the fields beside capabilityId — as the arguments', async () => {
      mockRun.mockResolvedValue({ ok: true, empty: false, text: 'sent' });
      await executeStandardTool(
        'run_capability',
        { to: 'x@y.com', subject: 's', body: 'b', recipient: 'x@y.com', capabilityId: 'cap_r.lookup' },
        baseCtx,
      );
      expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_r.lookup', { to: 'x@y.com', subject: 's', body: 'b', recipient: 'x@y.com' }, false, undefined, expect.any(Object), undefined);
    });

    it('a flattened write keeps its approval, keyed to the payload as proposed', async () => {
      mockRun.mockResolvedValue({ ok: true, empty: false, text: 'sent' });
      const ctx: StandardToolContext = { ...baseCtx, invocationId: 'inv-4' };
      const payload = { to: 'x@y.com', subject: 's', body: 'b', capabilityId: 'cap_w.send_email' };
      recordCapabilityApproval(capabilityApprovalKey('inv-4', payload));
      await executeStandardTool('run_capability', payload, ctx);
      expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_w.send_email', { to: 'x@y.com', subject: 's', body: 'b' }, true, undefined, expect.any(Object), undefined);
    });

    it('keeps the write approval keyed to the raw payload, so an approved stringified call dispatches approved', async () => {
      mockRun.mockResolvedValue({ ok: true, empty: false, text: 'sent' });
      const ctx: StandardToolContext = { ...baseCtx, invocationId: 'inv-3' };
      const payload = { arguments: JSON.stringify(email), capabilityId: 'cap_w.send_email' };
      // Armed on the payload as the gate saw it — the same object the handler reads.
      recordCapabilityApproval(capabilityApprovalKey('inv-3', payload));

      await executeStandardTool('run_capability', payload, ctx);
      // The real arguments reach the backend AND the approval is honoured.
      expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_w.send_email', email, true, undefined, expect.any(Object), undefined);
    });
  });
});

// The status of a capability run is the truth of whether it ran; the text is
// what the model sees either way. A refusal that came back as ordinary text
// used to be reported as a successful tool call, so an approved send could
// audit as done, count as dispatched, and never have happened.
describe('a capability that did not run is a failed tool call', () => {
  const NEUTRAL = 'This capability did not return a result. Report that plainly and do not state, guess, or speculate about a cause.';

  it('maps a refused outcome to success:false with the neutral text as the error', async () => {
    mockRun.mockResolvedValue({ ok: false, kind: 'refused', text: NEUTRAL });
    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_w.send', args: { to: 'x@y.com' } }, baseCtx);
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe(NEUTRAL);
  });

  it('maps a no-result outcome the same way', async () => {
    mockRun.mockResolvedValue({ ok: false, kind: 'no_result', text: NEUTRAL });
    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_r.lookup', args: {} }, baseCtx);
    expect(res.success).toBe(false);
  });

  it('reports a run that produced content as success with that content', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'Message sent (id 42)' });
    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_w.send', args: { to: 'x@y.com' } }, baseCtx);
    expect(res).toEqual({ success: true, result: 'Message sent (id 42)' });
  });
});

// A large result is kept by platform-backend as a dataset for this job — the
// conversation when there is one, else the run — and the dataset tools read it
// back for the same job. No capability is dispatched for any of them.
describe('the dataset tools and the job a result is parked for', () => {
  const mockDataset = runDatasetToolViaBackend as jest.MockedFunction<typeof runDatasetToolViaBackend>;
  beforeEach(() => { mockDataset.mockReset(); mockRun.mockReset(); });

  it('run_capability names the job (the thread over the run) and the dataset to add to', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'kept as dataset …' });
    await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: { q: 'x' }, appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' }, { ...baseCtx, threadId: 'thread-1', invocationId: 'inv-1' });
    expect(mockRun).toHaveBeenCalledWith('tenant-1', undefined, 'cap_abc', { q: 'x' }, false, undefined, { scopeId: 'thread-1', appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' }, undefined);
    await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: {} }, { ...baseCtx, invocationId: 'inv-1' });
    expect(mockRun).toHaveBeenLastCalledWith('tenant-1', undefined, 'cap_abc', {}, false, undefined, { scopeId: 'inv-1' }, undefined);
  });

  it('each dataset tool asks platform-backend for the same job and returns its text', async () => {
    mockDataset.mockResolvedValue('rows…');
    const res = await executeStandardTool('dataset_query', { datasetId: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11', select: ['title'] }, { ...baseCtx, invocationId: 'inv-1' });
    expect(res).toEqual({ success: true, result: 'rows…' });
    expect(mockDataset).toHaveBeenCalledWith('tenant-1', 'dataset_query', { datasetId: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11', select: ['title'] }, 'inv-1');
    await executeStandardTool('dataset_extract', { datasetId: 'x', instruction: 'themes' }, baseCtx);
    expect(mockDataset).toHaveBeenLastCalledWith('tenant-1', 'dataset_extract', { datasetId: 'x', instruction: 'themes' }, undefined);
    await executeStandardTool('dataset_list', {}, { ...baseCtx, threadId: 'thread-1' });
    expect(mockDataset).toHaveBeenLastCalledWith('tenant-1', 'dataset_list', {}, 'thread-1');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a transport failure is a failed call with the cause, never a fabricated answer', async () => {
    mockDataset.mockRejectedValue(new Error('HTTP 503'));
    expect(await executeStandardTool('dataset_query', { datasetId: 'x' }, baseCtx)).toEqual({ success: false, error: 'dataset_query failed: HTTP 503' });
  });

  it('run_capability without a capabilityId is refused before any call', async () => {
    const res = await executeStandardTool('run_capability', { args: {} }, baseCtx);
    expect(res).toEqual({ success: false, error: 'run_capability requires a capabilityId from a capability_search result' });
    expect(mockRun).not.toHaveBeenCalled();
  });
});
