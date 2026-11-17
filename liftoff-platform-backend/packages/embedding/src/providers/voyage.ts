import {
  EmbeddingError,
  type EmbeddingProviderCapabilities,
  type EmbeddingProviderClient,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type EmbeddingTaskType,
} from '../types';
import { fetchJsonWithRetry } from './http';

const DEFAULT_MODEL = 'voyage-4';
// Voyage's per-call input limit. Going over returns HTTP 400.
//   https://docs.voyageai.com/reference/embeddings-api
const MAX_INSTANCES_PER_CALL = 128;

function mapInputType(t: EmbeddingTaskType | undefined): 'query' | 'document' | undefined {
  if (t === 'retrieval_query') return 'query';
  if (t === 'retrieval_document') return 'document';
  return undefined;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

export class VoyageEmbeddingProvider implements EmbeddingProviderClient {
  readonly provider = 'voyage' as const;
  readonly capabilities: EmbeddingProviderCapabilities = {
    taskType: true,
    maxBatchSize: MAX_INSTANCES_PER_CALL,
    matryoshka: true,
  };
  readonly defaultModel = DEFAULT_MODEL;

  constructor(private apiKey: string) {
    if (!apiKey) throw new Error('VoyageEmbeddingProvider: apiKey required');
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model ?? DEFAULT_MODEL;
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const inputType = mapInputType(request.taskType);

    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let start = 0; start < inputs.length; start += MAX_INSTANCES_PER_CALL) {
      const slice = inputs.slice(start, start + MAX_INSTANCES_PER_CALL);
      const body: Record<string, unknown> = { model, input: slice };
      if (request.dimensions) body.output_dimension = request.dimensions;
      if (inputType) body.input_type = inputType;

      const r = await fetchJsonWithRetry<VoyageResponse>('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        provider: this.provider,
        // Per-call transport bounds; undefined falls back to the transport
        // defaults (30s / 2 retries) via fetchJsonWithRetry's ?? handling.
        timeoutMs: request.timeoutMs,
        retries: request.retries,
      });

      if (!Array.isArray(r.data) || r.data.length !== slice.length) {
        throw new EmbeddingError(
          `Voyage: returned ${r.data?.length ?? 0} embeddings for ${slice.length} inputs`,
          { kind: 'unknown', provider: this.provider },
        );
      }
      // Voyage's response can be returned out of order; sort by index then
      // validate each embedding is a numeric array.
      const ordered = [...r.data].sort((a, b) => a.index - b.index);
      for (let i = 0; i < ordered.length; i++) {
        const e = ordered[i].embedding;
        if (!Array.isArray(e)) {
          throw new EmbeddingError(
            `Voyage: data[${start + i}] missing numeric embedding`,
            { kind: 'unknown', provider: this.provider },
          );
        }
        allEmbeddings.push(e);
      }
      totalTokens += r.usage.total_tokens;
    }

    return { embeddings: allEmbeddings, promptTokens: totalTokens, model, provider: this.provider };
  }
}
