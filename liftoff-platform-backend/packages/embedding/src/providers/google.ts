import { GoogleAuth } from 'google-auth-library';
import {
  EmbeddingError,
  type EmbeddingProviderCapabilities,
  type EmbeddingProviderClient,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type EmbeddingTaskType,
} from '../types';
import { fetchJsonWithRetry } from './http';

// Default to gemini-embedding-001 with Matryoshka truncation to 768d:
// state-of-the-art retrieval quality, multilingual, and at the smallest
// well-supported truncation point. Callers can override via request.model
// (e.g. 'text-embedding-005' for cost-sensitive paths).
const DEFAULT_MODEL = 'gemini-embedding-001';
const DEFAULT_DIMENSIONS = 768;

// Vertex AI `:predict` endpoint hard limit on `instances`. Going over returns
// HTTP 400. We chunk client-side to stay safely below.
const MAX_INSTANCES_PER_CALL = 250;

export interface GoogleEmbeddingProviderConfig {
  projectId: string;
  location: string;
}

function mapTaskType(t: EmbeddingTaskType | undefined): string | undefined {
  // Vertex expects uppercase enum values. See:
  //   https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings#api_changes_to_models_released_on_or_after_august_2023
  if (t === 'retrieval_query') return 'RETRIEVAL_QUERY';
  if (t === 'retrieval_document') return 'RETRIEVAL_DOCUMENT';
  return undefined;
}

interface VertexPrediction {
  embeddings: { values: number[]; statistics?: { token_count?: number } };
}

export class GoogleEmbeddingProvider implements EmbeddingProviderClient {
  readonly provider = 'google' as const;
  readonly capabilities: EmbeddingProviderCapabilities = {
    taskType: true,
    maxBatchSize: MAX_INSTANCES_PER_CALL,
    matryoshka: true,
  };
  readonly defaultModel = DEFAULT_MODEL;
  private auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  constructor(private config: GoogleEmbeddingProviderConfig) {
    if (!config.projectId) throw new Error('GoogleEmbeddingProvider: projectId required');
    if (!config.location)  throw new Error('GoogleEmbeddingProvider: location required');
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model ?? DEFAULT_MODEL;
    const dimensions = request.dimensions ?? DEFAULT_DIMENSIONS;
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const taskType = mapTaskType(request.taskType);

    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) {
      throw new EmbeddingError('Vertex AI: failed to obtain access token', {
        kind: 'auth', provider: this.provider,
      });
    }

    const endpoint =
      `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/` +
      `${this.config.projectId}/locations/${this.config.location}/publishers/google/models/${model}:predict`;

    // Chunk over MAX_INSTANCES_PER_CALL. Sequential keeps memory bounded and
    // avoids hammering quota; embedding latency at batch=250 is ~1-2s so the
    // total wall time for typical worker batches (≤50 chunks/item) is fine.
    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let start = 0; start < inputs.length; start += MAX_INSTANCES_PER_CALL) {
      const slice = inputs.slice(start, start + MAX_INSTANCES_PER_CALL);
      const body = await fetchJsonWithRetry<{ predictions: VertexPrediction[] }>(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.token}`,
        },
        body: JSON.stringify({
          instances: slice.map(content => ({
            content,
            ...(taskType ? { task_type: taskType } : {}),
          })),
          // Matryoshka truncation. gemini-embedding-001 supports
          // 128/256/512/768/1536/3072; text-embedding-005 supports 256/512/768;
          // text-embedding-004 ignores this parameter (768 only).
          parameters: { outputDimensionality: dimensions },
        }),
        provider: this.provider,
        // Per-call transport bounds; undefined falls back to the transport
        // defaults (30s / 2 retries) via fetchJsonWithRetry's ?? handling.
        timeoutMs: request.timeoutMs,
        retries: request.retries,
      });

      if (!Array.isArray(body.predictions) || body.predictions.length !== slice.length) {
        throw new EmbeddingError(
          `Vertex AI: returned ${body.predictions?.length ?? 0} predictions for ${slice.length} inputs`,
          { kind: 'unknown', provider: this.provider },
        );
      }
      for (let i = 0; i < body.predictions.length; i++) {
        const p = body.predictions[i];
        if (!p?.embeddings?.values || !Array.isArray(p.embeddings.values)) {
          throw new EmbeddingError(
            `Vertex AI: prediction ${start + i} missing embeddings.values`,
            { kind: 'unknown', provider: this.provider },
          );
        }
        allEmbeddings.push(p.embeddings.values);
        const reported = p.embeddings.statistics?.token_count;
        totalTokens += typeof reported === 'number'
          ? reported
          : Math.ceil(slice[i].length / 4);  // ~4 chars/token fallback
      }
    }

    return { embeddings: allEmbeddings, promptTokens: totalTokens, model, provider: this.provider };
  }
}
