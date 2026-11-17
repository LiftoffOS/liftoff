import OpenAI from 'openai';
import {
  EmbeddingError,
  type EmbeddingProviderCapabilities,
  type EmbeddingProviderClient,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from '../types';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;
// OpenAI's per-call array limit. The SDK enforces retries/timeouts internally
// (default 2 retries, 10-min timeout) so we don't need fetchJsonWithRetry —
// just chunk to stay under the API's 2048-input ceiling.
//   https://platform.openai.com/docs/api-reference/embeddings/create
const MAX_INSTANCES_PER_CALL = 2048;

export class OpenAIEmbeddingProvider implements EmbeddingProviderClient {
  readonly provider = 'openai' as const;
  readonly capabilities: EmbeddingProviderCapabilities = {
    // text-embedding-3 family is symmetric — no task_type/input_type accepted.
    taskType: false,
    maxBatchSize: MAX_INSTANCES_PER_CALL,
    // text-embedding-3-small/large support output dim 256-1536 / 256-3072 via
    // the `dimensions` parameter (Matryoshka-style truncation, normalized).
    matryoshka: true,
  };
  readonly defaultModel = DEFAULT_MODEL;

  constructor(private client: OpenAI) {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model ?? DEFAULT_MODEL;
    const dimensions = request.dimensions ?? DEFAULT_DIMENSIONS;
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let start = 0; start < inputs.length; start += MAX_INSTANCES_PER_CALL) {
      const slice = inputs.slice(start, start + MAX_INSTANCES_PER_CALL);
      let response;
      try {
        // Per-request transport bounds: the SDK accepts { timeout, maxRetries }
        // as the second (request-options) argument, overriding its defaults
        // (2 retries, 10-min timeout) for this call only. Undefined values
        // fall back to the SDK defaults.
        response = await this.client.embeddings.create(
          { model, input: slice, dimensions },
          { timeout: request.timeoutMs, maxRetries: request.retries },
        );
      } catch (raw) {
        // The OpenAI SDK throws APIError subclasses with `.status`. Wrap into
        // EmbeddingError so consumers can branch uniformly.
        const err = raw as { status?: number; message?: string };
        const status = typeof err.status === 'number' ? err.status : undefined;
        const kind =
          status === 401 || status === 403 ? 'auth'
          : status === 429 ? 'rate_limit'
          : status && status >= 500 ? 'transient'
          : status && status >= 400 ? 'invalid'
          : 'transient';
        throw new EmbeddingError(`OpenAI embeddings.create failed: ${err.message ?? String(raw)}`, {
          kind, status, provider: this.provider, cause: raw,
        });
      }
      if (!Array.isArray(response.data) || response.data.length !== slice.length) {
        throw new EmbeddingError(
          `OpenAI: returned ${response.data?.length ?? 0} embeddings for ${slice.length} inputs`,
          { kind: 'unknown', provider: this.provider },
        );
      }
      for (let i = 0; i < response.data.length; i++) {
        const e = response.data[i].embedding;
        if (!Array.isArray(e)) {
          throw new EmbeddingError(
            `OpenAI: data[${start + i}] missing numeric embedding`,
            { kind: 'unknown', provider: this.provider },
          );
        }
        allEmbeddings.push(e);
      }
      totalTokens += response.usage.prompt_tokens;
    }

    return { embeddings: allEmbeddings, promptTokens: totalTokens, model, provider: this.provider };
  }
}
