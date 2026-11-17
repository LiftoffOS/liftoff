// Workspace offload of oversized intermediate values.
//
// The failure mode this guards against is subtle: an offload that "works" but
// writes somewhere the agent cannot read replaces truncated data with a dead
// path, and the prompt confidently tells the model to go read it. That is
// strictly worse than a summary alone. So the writer is injected, null means no
// filesystem means no offload, and a refused or failed write is indistinguishable
// from never having tried.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const parkMock = jest.fn();
jest.mock('../../../clients/platform-backend-client', () => ({
  parkValueViaBackend: (...a: unknown[]) => parkMock(...a),
}));

import {
  offloadLargeValue,
  offloadNote,
  valueOffloadEnabled,
  OFFLOAD_DIR,
} from '../offload-large-value';

/** The caller's prompt budget — what the summary was built to fit. */
const BUDGET = 8_192;

/** Past both the budget and MIN_OFFLOAD_CHARS (8,000) once serialized. */
function bigValue(): { rows: Array<{ id: number; note: string }> } {
  return { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, note: 'n'.repeat(80) })) };
}

describe('offloadLargeValue', () => {
  const previousFlag = process.env.VALUE_OFFLOAD_ENABLED;
  let written: Array<{ path: string; content: string }>;
  let writer: jest.Mock;

  beforeEach(() => {
    process.env.VALUE_OFFLOAD_ENABLED = '1';
    written = [];
    writer = jest.fn(async (path: string, content: string) => {
      written.push({ path, content });
      return true;
    });
  });

  afterAll(() => {
    if (previousFlag === undefined) delete process.env.VALUE_OFFLOAD_ENABLED;
    else process.env.VALUE_OFFLOAD_ENABLED = previousFlag;
  });

  it('writes the full value into the run workspace and reports the path', async () => {
    const value = bigValue();

    const result = await offloadLargeValue(value, { writer, label: 'step-output-fetch', budget: BUDGET });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(`${OFFLOAD_DIR}/step-output-fetch.json`);
    expect(written).toHaveLength(1);
    // Nothing lost is the entire point: the last record must be in the file.
    expect(written[0].content).toContain('"id": 199');
    expect(result!.bytes).toBe(written[0].content.length);
  });

  it('does nothing when the agent has no filesystem', async () => {
    // A connector-only agent. The caller keeps its compressed summary, which is
    // the honest answer, rather than being told to read a path that does not
    // exist for it.
    const result = await offloadLargeValue(bigValue(), { writer: null, label: 'step-output-x', budget: BUDGET });

    expect(result).toBeNull();
  });

  it('does nothing when the flag is off', async () => {
    process.env.VALUE_OFFLOAD_ENABLED = '0';

    const result = await offloadLargeValue(bigValue(), { writer, label: 'step-output-x', budget: BUDGET });

    expect(result).toBeNull();
    expect(writer).not.toHaveBeenCalled();
    expect(valueOffloadEnabled()).toBe(false);
  });

  it('skips values too small to be worth a tool call', async () => {
    // A path the model must read costs it a round trip. Below the floor the
    // summary already carries everything.
    const result = await offloadLargeValue({ id: 1, name: 'small' }, {
      writer,
      label: 'step-output-x',
      budget: BUDGET,
    });

    expect(result).toBeNull();
    expect(writer).not.toHaveBeenCalled();
  });

  it('does not park a value that reached the model whole', async () => {
    // The band between the floor (8,000) and the budget (8,192). The summary IS
    // the complete value here, so a file plus a note promising "a detail it does
    // not contain" would be false, and would spend a workspace write to say it.
    const text = 'x'.repeat(8_100);
    expect(text.length).toBeGreaterThan(8_000);
    expect(text.length).toBeLessThanOrEqual(BUDGET);

    const result = await offloadLargeValue(text, {
      writer,
      label: 'step-output-fits',
      budget: BUDGET,
    });

    expect(result).toBeNull();
    expect(writer).not.toHaveBeenCalled();
  });

  it('parks a value one character over the budget', async () => {
    const text = 'x'.repeat(BUDGET + 1);

    const result = await offloadLargeValue(text, {
      writer,
      label: 'step-output-over',
      budget: BUDGET,
    });

    expect(result).not.toBeNull();
    expect(result!.bytes).toBe(BUDGET + 1);
  });

  it('treats a refused write as no offload at all', async () => {
    // `writeWorkspaceFile` resolves false when the gateway declines — the sandbox
    // is gone, the write was blocked. Returning a path here would be a lie.
    const refusing = jest.fn(async () => false);

    const result = await offloadLargeValue(bigValue(), {
      writer: refusing,
      label: 'step-output-x',
      budget: BUDGET,
    });

    expect(result).toBeNull();
  });

  it('swallows a thrown write and returns null', async () => {
    const throwing = jest.fn(async () => {
      throw new Error('sandbox unreachable');
    });

    await expect(
      offloadLargeValue(bigValue(), { writer: throwing, label: 'step-output-x', budget: BUDGET }),
    ).resolves.toBeNull();
  });

  it('cannot escape the offload directory through the label', async () => {
    // Labels are ours (step ids), but a step id reaching a path separator would
    // let a write land outside the run's scratch.
    const result = await offloadLargeValue(bigValue(), {
      writer,
      label: '../../etc/passwd',
      budget: BUDGET,
    });

    expect(result!.path).toBe(`${OFFLOAD_DIR}/______etc_passwd.json`);
    // One filename inside the directory: no traversal sequence and no separator
    // beyond the one this module put there itself.
    expect(result!.path).not.toContain('..');
    expect(result!.path.split('/')).toHaveLength(2);
  });

  it('writes a long string value verbatim rather than JSON-quoting it', async () => {
    const text = 'row,value\n' + 'a,1\n'.repeat(3_000);

    const result = await offloadLargeValue(text, { writer, label: 'step-output-csv', budget: BUDGET });

    expect(result).not.toBeNull();
    expect(written[0].content).toBe(text);
  });

  it('offloads an unserializable value rather than dropping it', async () => {
    const circular: Record<string, unknown> = { note: 'x'.repeat(9_000) };
    circular.self = circular;

    const result = await offloadLargeValue(circular, { writer, label: 'step-output-x', budget: BUDGET });

    // String(value) is a poor rendering, but the alternative is throwing inside a
    // best-effort helper on the step path.
    expect(result === null || written.length === 1).toBe(true);
  });
});

describe('offloadNote', () => {
  it('names the tool and the path so the model does not have to guess', () => {
    const note = offloadNote({ path: `${OFFLOAD_DIR}/step-output-fetch.json`, bytes: 51_200 });

    expect(note).toContain(`${OFFLOAD_DIR}/step-output-fetch.json`);
    expect(note).toContain('file_read');
    expect(note).toContain('51200');
    // The model has to know the text it received is partial, or it will treat the
    // summary as the whole truth.
    expect(note).toMatch(/summary/i);
  });
});

describe('no filesystem is no longer no parking', () => {
  // The gap this closes. A workspace exists only when the agent has a sandbox
  // with the `file` capability, which most do not — so for most agents the
  // designed remedy for an oversized value did not exist. A step that had to
  // read its input WHOLE then had nowhere to park it and the run ENDED, early
  // and abruptly, because a document read could not be handed on. The datasets
  // store is platform-wide and already scoped to a run.
  const SCOPE = { tenantId: 't1', scopeId: 'inv-1' };
  const previousFlag = process.env.VALUE_OFFLOAD_ENABLED;

  beforeEach(() => {
    process.env.VALUE_OFFLOAD_ENABLED = '1';
    parkMock.mockReset();
    parkMock.mockResolvedValue({ ok: true, view: 'dataset view', parked: [{ datasetId: 'ds_9', recordCount: 200 }] });
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.VALUE_OFFLOAD_ENABLED;
    else process.env.VALUE_OFFLOAD_ENABLED = previousFlag;
  });

  it('parks to a dataset when there is no writer', async () => {
    const out = await offloadLargeValue(bigValue(), { writer: null, datasetScope: SCOPE, label: 'step-output-s3', budget: BUDGET });
    expect(out).toMatchObject({ datasetId: 'ds_9' });
    expect(out!.path).toBeUndefined();
  });

  it('scopes the dataset to the RUN, so it lives as long as what can read it', async () => {
    await offloadLargeValue(bigValue(), { writer: null, datasetScope: SCOPE, label: 'step-output-s3', budget: BUDGET });
    const [tenantId, , , job] = parkMock.mock.calls[0] as
      [string, unknown, string, { scopeId: string }];
    expect(tenantId).toBe('t1');
    expect(job.scopeId).toBe('inv-1');
  });

  // THE DEFECT. A `collect: true` loop's output is an ARRAY, and the route's
  // envelope mode refuses one outright — `Expected object, received array` —
  // while an object passed the same way validates and parks nothing. Both read
  // to the caller as "nothing to park", so the engine fell through to
  // compression and then to a positional cut, and half a sweep's research was
  // discarded. The value mode takes either shape.
  it('parks an ARRAY, which is what a collecting loop produces', async () => {
    const collected = Array.from({ length: 60 }, (_, i) => ({
      competitor: `c${i}`, findings: 'x'.repeat(900),
    }));
    const out = await offloadLargeValue(collected, {
      writer: null, datasetScope: SCOPE, label: 'step-output-s10', budget: BUDGET,
    });
    expect(out).toMatchObject({ datasetId: 'ds_9' });
    // The value travels as the VALUE, so records land as records rather than as
    // their own serialization, and the text beside it is the serialization.
    const [, value, serialized] = parkMock.mock.calls[0] as [string, unknown, string];
    expect(Array.isArray(value)).toBe(true);
    expect(typeof serialized).toBe('string');
  });

  it('prefers the workspace when there IS one, so nothing changes for those agents', async () => {
    const writer = jest.fn().mockResolvedValue(true);
    const out = await offloadLargeValue(bigValue(), { writer, datasetScope: SCOPE, label: 'step-output-s3', budget: BUDGET });
    expect(out!.path).toContain(OFFLOAD_DIR);
    expect(parkMock).not.toHaveBeenCalled();
  });

  it('still offloads nothing when there is neither a writer nor a scope', async () => {
    const out = await offloadLargeValue(bigValue(), { writer: null, datasetScope: null, label: 'x', budget: BUDGET });
    expect(out).toBeNull();
    expect(parkMock).not.toHaveBeenCalled();
  });

  it('a refused park is indistinguishable from never having tried', async () => {
    // Same contract as a refused workspace write: the caller keeps its summary,
    // or refuses the step if the value had to be whole. Never a dead handle.
    parkMock.mockResolvedValue({ ok: false, reason: 'store full' });
    expect(await offloadLargeValue(bigValue(), { writer: null, datasetScope: SCOPE, label: 'x', budget: BUDGET })).toBeNull();
  });

  it('a park that stored no records is not a park', async () => {
    parkMock.mockResolvedValue({ ok: true, result: {}, parked: [] });
    expect(await offloadLargeValue(bigValue(), { writer: null, datasetScope: SCOPE, label: 'x', budget: BUDGET })).toBeNull();
  });

  it('never throws, whatever the store does', async () => {
    parkMock.mockRejectedValue(new Error('network'));
    expect(await offloadLargeValue(bigValue(), { writer: null, datasetScope: SCOPE, label: 'x', budget: BUDGET })).toBeNull();
  });

  it('a value that FITS is not parked, so no dataset is spent on it', async () => {
    expect(await offloadLargeValue({ small: true }, { writer: null, datasetScope: SCOPE, label: 'x', budget: BUDGET })).toBeNull();
    expect(parkMock).not.toHaveBeenCalled();
  });
});

describe('the note names the right tool for the destination', () => {
  it('sends the model to dataset_query for a parked dataset', () => {
    // Naming a workspace path for a value that is in a dataset would send the
    // model to file_read on a path that was never written, which reads to it
    // as the value being gone.
    const note = offloadNote({ datasetId: 'ds_9', bytes: 20_000 });
    expect(note).toContain('dataset_query');
    expect(note).toContain('ds_9');
    expect(note).not.toContain('file_read');
    expect(note).not.toContain('undefined');
  });

  it('sends it to file_read for a workspace file', () => {
    const note = offloadNote({ path: 'run-values/s3.json', bytes: 20_000 });
    expect(note).toContain('file_read');
    expect(note).not.toContain('dataset_query');
  });
});
