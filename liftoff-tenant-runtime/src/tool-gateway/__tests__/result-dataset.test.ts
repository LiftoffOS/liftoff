// The dataset contract: oversized connector results become workspace files of
// clean JSON, never framed blobs the model has to guess a format for.
//
// Every assertion maps to a link in the failure chain the contract breaks:
// frame + SDK spill -> unparseable file -> unnamed format -> wrong filesystem.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { datasetOrInlineWithCompleteness, DATASET_DIR } from '../result-dataset';

/** The text the caller contributes to context. Completeness itself is asserted
 *  in result-completeness-carrier.test.ts; these cases predate that field and
 *  are about the parked FILE and the note beside it. */
const datasetText = async (...args: Parameters<typeof datasetOrInlineWithCompleteness>) =>
  (await datasetOrInlineWithCompleteness(...args)).text;

const IDS = { tenantId: 't-1', agentId: 'a-1' };

/** Over the 50,000 calibrated bound once serialized. */
function bigJson(): string {
  return JSON.stringify({
    valueRanges: [
      { range: 'Sheet1!B:B', values: Array.from({ length: 1_600 }, (_, i) => [`https://example.com/campaign-${i}`]) },
    ],
  });
}

describe('datasetOrInlineWithCompleteness', () => {
  let written: Array<{ path: string; content: string }>;
  let writer: jest.Mock;

  beforeEach(() => {
    written = [];
    writer = jest.fn(async (path: string, content: string) => {
      written.push({ path, content });
      return true;
    });
  });

  it('returns a small result unchanged, without touching the filesystem', async () => {
    const small = JSON.stringify({ ok: true, rows: 3 });

    const out = await datasetText('batch_get_values', small, writer, IDS);

    expect(out).toBe(small);
    expect(writer).not.toHaveBeenCalled();
  });

  it('parks an oversized result as CLEAN JSON — parseable by json.load with no unwrapping', async () => {
    const serialized = bigJson();

    const out = await datasetText('batch_get_values', serialized, writer, IDS);

    expect(written).toHaveLength(1);
    // Parsing the file as-is is the whole contract — no unwrapping step.
    expect(() => JSON.parse(written[0].content)).not.toThrow();
    expect(written[0].content).toBe(serialized);
    expect(out).not.toBe(serialized);
  });

  it('the in-context text names the path, the format, and that it is a preview', async () => {
    const out = await datasetText('batch_get_values', bigJson(), writer, IDS);

    // The failure this guards against is exactly an unnamed format.
    expect(out).toContain('valid JSON');
    expect(out).toContain(written[0].path);
    expect(out).toMatch(/preview only/i);
    expect(out).toContain('jq');
    expect(out).toContain('file_read');
    // Two filesystems exist and only one holds the file: the note must warn off
    // the built-in shell, or the model is directed at a path it cannot see —
    // the same dead-path class this module fixes.
    expect(out).toMatch(/Bash shell.*cannot see/);
    expect(out).toContain('sandbox');
    // And the preview shows the shape the model will query for.
    expect(out).toContain('valueRanges');
  });

  it('files land inside the dataset directory with a sanitised name', async () => {
    await datasetText('../../etc/passwd', bigJson(), writer, IDS);

    expect(written[0].path.startsWith(`${DATASET_DIR}/`)).toBe(true);
    expect(written[0].path).not.toContain('..');
    expect(written[0].path.endsWith('.json')).toBe(true);
    expect(written[0].path.split('/')).toHaveLength(2);
  });

  it('two calls to the same tool cannot overwrite each other', async () => {
    await datasetText('batch_get_values', bigJson(), writer, IDS);
    await datasetText('batch_get_values', bigJson(), writer, IDS);

    expect(written[0].path).not.toBe(written[1].path);
  });

  it('is fail-open: no filesystem returns the result unchanged', async () => {
    // Whether an agent has a workspace is a distillation-time provisioning
    // decision; this module never degrades a result to compensate for it.
    const serialized = bigJson();
    expect(await datasetText('t', serialized, null, IDS)).toBe(serialized);
  });

  it('is fail-open: a refused or thrown write returns the result unchanged', async () => {
    const serialized = bigJson();
    const refusing = jest.fn(async () => false);
    const throwing = jest.fn(async () => { throw new Error('sandbox gone'); });

    expect(await datasetText('t', serialized, refusing, IDS)).toBe(serialized);
    expect(await datasetText('t', serialized, throwing, IDS)).toBe(serialized);
  });

  it('previews non-JSON content by slicing rather than dying', async () => {
    const notJson = 'x'.repeat(60_000);

    const out = await datasetText('t', notJson, writer, IDS);

    expect(written).toHaveLength(1);
    expect(out.length).toBeLessThan(notJson.length);
  });
});
