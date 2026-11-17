// One hypothetical document per search, not one per source.
//
// Memory retrieval and connector-content retrieval each build a HyDE document
// and embed it. A tool that searches both would buy two of them for one
// question. These tests pin the sharing: the builder produces the pair once,
// and memory retrieval skips its own when handed the result.

const mockHyde = jest.fn();
const mockEmbed = jest.fn();
jest.mock('../hyde', () => ({ generateHypotheticalDocument: (...a: unknown[]) => mockHyde(...a) }));
jest.mock('../embedding', () => ({ generateEmbedding: (...a: unknown[]) => mockEmbed(...a) }));

import { buildRetrievalVector } from '../retrieval-vector';

beforeEach(() => {
  jest.clearAllMocks();
  mockHyde.mockResolvedValue('a hypothetical answer');
  mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe('buildRetrievalVector', () => {
  it('writes one hypothetical document and embeds it once', async () => {
    const out = await buildRetrievalVector({ query: 'unpaid invoices', tenantId: 't1', agentId: 'a1' });

    expect(mockHyde).toHaveBeenCalledTimes(1);
    expect(mockHyde).toHaveBeenCalledWith('unpaid invoices', 't1', 'a1', undefined);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith('a hypothetical answer', expect.objectContaining({
      tenantId: 't1',
      agentId: 'a1',
      purpose: 'embedding_retrieval',
      taskType: 'retrieval_query',
    }));
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(out.embeddingJson).toBe('[0.1,0.2,0.3]');
  });

  it('embeds the raw query when HyDE fails, rather than giving up on retrieval', async () => {
    mockHyde.mockRejectedValue(new Error('provider overloaded'));
    const out = await buildRetrievalVector({ query: 'unpaid invoices', tenantId: 't1' });

    expect(mockEmbed).toHaveBeenCalledWith('unpaid invoices', expect.anything());
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('omits agentId entirely rather than passing undefined', async () => {
    await buildRetrievalVector({ query: 'q', tenantId: 't1' });
    expect(mockHyde).toHaveBeenCalledWith('q', 't1', undefined, undefined);
    expect(mockEmbed.mock.calls[0][1]).not.toHaveProperty('agentId');
  });
});

describe('cost attribution', () => {
  it('attributes the HyDE charge to the run that caused it', async () => {
    // `llm_usage_log.invocation_id` is populated straight from this context.
    // Without it the charge is real, the row exists, and nothing can say which
    // run to bill it to.
    await buildRetrievalVector({ query: 'q', tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' });
    expect(mockHyde).toHaveBeenCalledWith('q', 't1', 'a1', 'inv-1');
  });

  it('attributes the embedding to the same run', async () => {
    await buildRetrievalVector({ query: 'q', tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' });
    expect(mockEmbed).toHaveBeenCalledWith('a hypothetical answer', expect.objectContaining({
      invocationId: 'inv-1',
    }));
  });

  it('omits the key rather than writing an undefined invocation', async () => {
    await buildRetrievalVector({ query: 'q', tenantId: 't1' });
    expect(mockEmbed.mock.calls[0][1]).not.toHaveProperty('invocationId');
  });
});

describe('when the embedding provider is down', () => {
  beforeEach(() => {
    mockEmbed.mockRejectedValue(new Error('provider unreachable'));
  });

  it('reports it rather than throwing', async () => {
    // Throwing gives the caller no way to distinguish "no vector asked for"
    // from "provider down", so it hands each source a blank and every source
    // tries again — one outage becomes one failed call per source, per search.
    const out = await buildRetrievalVector({ query: 'q', tenantId: 't1' });
    expect(out.unavailable).toBe(true);
    expect(out.embedding).toBeNull();
    expect(out.embeddingJson).toBeNull();
  });

  it('calls the provider exactly once', async () => {
    await buildRetrievalVector({ query: 'q', tenantId: 't1' });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('marks a successful build as available', async () => {
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    const out = await buildRetrievalVector({ query: 'q', tenantId: 't1' });
    expect(out.unavailable).toBe(false);
  });
});
