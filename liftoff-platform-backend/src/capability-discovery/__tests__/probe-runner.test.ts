// A blueprint rises to probe evidence from a real run that returned results,
// and the model is shown the SHAPE of that output — field names and types —
// never a value from it. An empty run teaches nothing.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../blueprint-analyzer', () => ({ ensureBlueprintCompiled: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../evidence', () => ({ getConsumersOfRef: jest.fn().mockResolvedValue([]) }));

import { pool } from '../../infrastructure/database';
import { llmClient } from '../../llm/client';
import { log } from '../../infrastructure/logging';
import { ensureBlueprintCompiled } from '../blueprint-analyzer';
import { elevateBlueprintFromRun } from '../probe-runner';

const queryMock = pool.query as jest.Mock;
const completeMock = llmClient.complete as jest.Mock;

/** Each elevation is deduped per ref per process, so every case uses its own ref. */
let refCounter = 0;
const nextRef = () => `vendor/actor-${++refCounter}`;

beforeEach(() => {
  jest.clearAllMocks();
});

const ITEMS = [
  {
    title: 'SECRET-TITLE-ONE',
    url: 'https://www.reddit.com/r/explainlikeimfive/comments/abc/secret_slug/',
    score: 21,
    author: { name: 'private-person', karma: 1234 },
    comments: [{ body: 'PRIVATE COMMENT TEXT', score: 3 }],
    nsfw: false,
  },
  {
    title: 'SECRET-TITLE-TWO',
    url: 'https://www.reddit.com/r/explainlikeimfive/comments/def/other_slug/',
    score: 7,
    author: { name: 'another-person', karma: 55 },
    comments: [],
    nsfw: false,
    flair: 'Economics',
  },
];

describe('elevateBlueprintFromRun', () => {
  it('teaches nothing from an empty run: no model call, no write', async () => {
    await elevateBlueprintFromRun({ source: 'apify_store', sourceRef: nextRef(), items: [], runId: 'run-empty' });

    expect(completeMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'capability_probe.inconclusive', runId: 'run-empty' }),
      expect.any(String),
    );
  });

  it('shows the model field names and types, never a value, and records the run id', async () => {
    const sourceRef = nextRef();
    queryMock
      .mockResolvedValueOnce({ rows: [{ procedure_md: '## Procedure\n- old output contract' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'bp-1' }], rowCount: 1 });
    completeMock.mockResolvedValue({ content: JSON.stringify({ procedureMd: '## Procedure\n- refined' }) });

    await elevateBlueprintFromRun({ source: 'apify_store', sourceRef, items: ITEMS, runId: 'run-real' });

    expect(ensureBlueprintCompiled).toHaveBeenCalledWith('apify_store', sourceRef);
    const prompt = JSON.stringify(completeMock.mock.calls[0][0]);
    // The shape is there: names, types, one level into objects and arrays.
    expect(prompt).toContain('OBSERVED OUTPUT SHAPE (2 items examined)');
    expect(prompt).toContain('- title: string (present in 2 of 2)');
    expect(prompt).toContain('- score: number (present in 2 of 2)');
    expect(prompt).toContain('- author.name: string (present in 2 of 2)');
    expect(prompt).toContain('- comments[].body: string (present in 1 of 2)');
    expect(prompt).toContain('- flair: string (present in 1 of 2)');
    expect(prompt).toContain('- nsfw: boolean');
    // No value from the run reaches the model.
    for (const value of ['SECRET-TITLE', 'reddit.com', 'secret_slug', 'private-person', 'PRIVATE COMMENT', '1234', 'Economics']) {
      expect(prompt).not.toContain(value);
    }

    const update = queryMock.mock.calls[1];
    expect(update[0]).toContain("SET evidence_level = 'probe'");
    expect(update[1]).toEqual(['apify_store', sourceRef, '## Procedure\n- refined', 'apify:run:run-real']);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'capability_probe.elevated', runId: 'run-real', itemsExamined: 2 }),
      expect.any(String),
    );
  });

  it('does nothing when there is no metadata-level row to raise', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await elevateBlueprintFromRun({ source: 'apify_store', sourceRef: nextRef(), items: ITEMS, runId: 'run-x' });

    expect(completeMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('ignores sources that are not store automations', async () => {
    await elevateBlueprintFromRun({ source: 'connector_registry', sourceRef: 'zoho:list', items: ITEMS, runId: 'run-y' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('never throws into the caller when the model or the database fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      elevateBlueprintFromRun({ source: 'apify_store', sourceRef: nextRef(), items: ITEMS, runId: 'run-z' }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.stringContaining('unchanged'));
  });
});
