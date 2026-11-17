// Memory retrieval is bounded when its providers stop answering.
//
// Retrieval runs before "Invocation started": the run waits on it. After an
// instance-level network reset a pooled connection can go dead yet still be
// reused, and a request on it waits for its caller's own timer. HyDE used to
// inherit the provider default (10 min x 4 attempts) and the query embedding
// the transport default (30s x 3), so a dead connection held the run silent for
// minutes. These tests drive the REAL SDKs against a local server that accepts
// and never answers, and pin that retrieval comes back within the new bound —
// on the raw query when HyDE is the one that hangs.

import http from 'http';
import type { AddressInfo } from 'net';
import OpenAI from 'openai';
import { embeddingClient, OpenAIEmbeddingProvider } from '@liftoffos/embedding';
import { waitForNoHeldRequests } from '../../test-utils/wait-for';

jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: jest.fn().mockResolvedValue(null) }),
}));
jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../infrastructure/secret-store', () => ({ getManagedSecret: () => undefined }));

// HyDE goes through the real Anthropic provider, pointed at the fake server.
let anthropicBaseUrl = '';
jest.mock('../../llm/client', () => ({
  llmClient: {
    modelSelectionFor: () => ({}),
    complete: async (request: import('../../llm/types').LLMCompletionRequest) => {
      const { AnthropicProvider } = jest.requireActual('../../llm/providers/anthropic');
      return AnthropicProvider.createForGateway(anthropicBaseUrl, 'test-token').complete(request);
    },
  },
}));

import { buildRetrievalVector } from '../retrieval-vector';
import { hydeCallBounds } from '../hyde';
import { queryEmbeddingBounds } from '../embedding';

type Mode = 'hang' | 'answer';

interface FakeServer {
  url: string;
  hits: { messages: number; embeddings: string[] };
  /** Requests the server is still holding open. Zero after a bounded call:
   *  the client aborted its sockets rather than abandoning them. */
  held: () => number;
  close: () => Promise<void>;
}

async function startFakeServer(modes: { messages: Mode; embeddings: Mode }): Promise<FakeServer> {
  const hits = { messages: 0, embeddings: [] as string[] };
  let held = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isEmbeddings = req.url?.endsWith('/embeddings') ?? false;
      if (isEmbeddings) hits.embeddings.push((JSON.parse(body) as { input: string[] | string }).input.toString());
      else hits.messages += 1;
      const mode = isEmbeddings ? modes.embeddings : modes.messages;
      if (mode === 'hang') {
        held += 1;
        res.on('close', () => { held -= 1; });
        return; // accept, never answer
      }
      // The SDK asks for base64 by default and decodes it; answer in kind.
      const vector = new Array(1536).fill(0.01);
      const embedding = (JSON.parse(body) as { encoding_format?: string }).encoding_format === 'base64'
        ? Buffer.from(new Float32Array(vector).buffer).toString('base64')
        : vector;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        object: 'list',
        model: 'text-embedding-3-small',
        data: [{ object: 'embedding', index: 0, embedding }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    held: () => held,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const ENV_KEYS = [
  'MEM_HYDE_TIMEOUT_MS', 'MEM_HYDE_MAX_RETRIES',
  'MEM_QUERY_EMBED_TIMEOUT_MS', 'MEM_QUERY_EMBED_RETRIES', 'EMBEDDING_PROVIDER',
] as const;
const savedEnv: Record<string, string | undefined> = {};

describe('memory retrieval bounds', () => {
  let server: FakeServer | undefined;

  beforeAll(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    // Short bounds so the real timers run in test time; the defaults are
    // pinned separately below.
    process.env.MEM_HYDE_TIMEOUT_MS = '300';
    process.env.MEM_HYDE_MAX_RETRIES = '1';
    process.env.MEM_QUERY_EMBED_TIMEOUT_MS = '300';
    process.env.MEM_QUERY_EMBED_RETRIES = '1';
    process.env.EMBEDDING_PROVIDER = 'openai';
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    embeddingClient.reset();
  });

  function useServer(s: FakeServer): void {
    server = s;
    anthropicBaseUrl = s.url;
    embeddingClient.reset();
    embeddingClient.init({
      providers: { openai: new OpenAIEmbeddingProvider(new OpenAI({ apiKey: 'test', baseURL: `${s.url}/v1` })) },
      defaultProvider: 'openai',
    });
  }

  it('embeds the raw query within the HyDE bound when the LLM never answers', async () => {
    useServer(await startFakeServer({ messages: 'hang', embeddings: 'answer' }));

    const startedAt = Date.now();
    const out = await buildRetrievalVector({ query: 'unpaid invoices', tenantId: 't1', agentId: 'a1' });
    const elapsed = Date.now() - startedAt;

    expect(out.unavailable).toBe(false);
    expect(out.embedding).toHaveLength(1536);
    // The raw query, not a hypothetical document: HyDE fell back.
    expect(server!.hits.embeddings).toEqual(['unpaid invoices']);
    // One attempt plus exactly one retry: the per-call maxRetries reached the SDK.
    expect(server!.hits.messages).toBe(2);
    // 2 x 300ms plus SDK backoff; the old default was 10 min per attempt.
    expect(elapsed).toBeLessThan(5_000);
    // Waited for, not slept through — see test-utils/wait-for.ts. A fixed
    // sleep here read a socket count that had not settled yet.
    await waitForNoHeldRequests(server!.held, 'the fake provider');
  }, 15_000);

  it('reports the vector unavailable within the bound when the embedding never answers either', async () => {
    useServer(await startFakeServer({ messages: 'hang', embeddings: 'hang' }));

    const startedAt = Date.now();
    const out = await buildRetrievalVector({ query: 'unpaid invoices', tenantId: 't1' });
    const elapsed = Date.now() - startedAt;

    // Sources go lexical instead of the run waiting on a dead connection.
    expect(out).toEqual({ embedding: null, embeddingJson: null, unavailable: true });
    expect(server!.hits.messages).toBe(2);
    expect(server!.hits.embeddings).toHaveLength(2);
    expect(elapsed).toBeLessThan(8_000);
    // Waited for, not slept through — see test-utils/wait-for.ts. A fixed
    // sleep here read a socket count that had not settled yet.
    await waitForNoHeldRequests(server!.held, 'the fake provider');
  }, 20_000);

  it('defaults to 8s x 2 attempts for HyDE and 5s x 2 attempts for a query embedding', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(hydeCallBounds()).toEqual({ timeoutMs: 8_000, maxRetries: 1 });
    expect(queryEmbeddingBounds()).toEqual({ timeoutMs: 5_000, retries: 1 });
  });

  it('leaves non-query embeddings on the transport defaults', async () => {
    const embedSpy = jest.spyOn(embeddingClient, 'embed').mockResolvedValue({
      embeddings: [new Array(1536).fill(0)], promptTokens: 1, model: 'text-embedding-3-small', provider: 'openai',
    });
    const { generateEmbedding } = await import('../embedding');

    await generateEmbedding('a document', { provider: 'openai' });
    expect(embedSpy.mock.calls[0][0]).not.toHaveProperty('timeoutMs');
    expect(embedSpy.mock.calls[0][0]).not.toHaveProperty('retries');

    await generateEmbedding('a query', { provider: 'openai', taskType: 'retrieval_query' });
    expect(embedSpy.mock.calls[1][0]).toMatchObject({ timeoutMs: 300, retries: 1 });
  });
});
