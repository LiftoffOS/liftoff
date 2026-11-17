// Shared HTTP helper for raw-fetch providers (Google Vertex, Voyage).
// Adds:
//   - per-call AbortController timeout (default 30s)
//   - bounded retry on transient classes (5xx, 429, network errors)
//   - classification of HTTP errors into EmbeddingError.kind so consumers
//     can decide retry vs surface

import { EmbeddingError, type EmbeddingErrorKind } from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 250;

export interface FetchJsonOptions {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  provider: string;
  /** Per-call timeout. Defaults to 30s. Set lower for query-time embeds,
   *  higher for large batches. */
  timeoutMs?: number;
  /** Max retries on transient (5xx, 429, network) errors. Defaults to 2. */
  retries?: number;
}

function classifyHttpStatus(status: number): EmbeddingErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status < 600) return 'transient';
  if (status >= 400 && status < 500) return 'invalid';
  return 'unknown';
}

function isRetryable(kind: EmbeddingErrorKind): boolean {
  return kind === 'transient' || kind === 'rate_limit';
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Fetches `url` and decodes JSON. Throws EmbeddingError with classified kind
 *  on any failure. Retries up to `retries` times on transient/rate-limit
 *  classes with exponential backoff + small jitter. */
export async function fetchJsonWithRetry<T>(url: string, opts: FetchJsonOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.retries ?? DEFAULT_RETRIES;
  let lastErr: EmbeddingError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const kind = classifyHttpStatus(resp.status);
        const bodyText = await resp.text().catch(() => '');
        const err = new EmbeddingError(
          `${opts.provider} HTTP ${resp.status}: ${bodyText.slice(0, 500)}`,
          { kind, status: resp.status, provider: opts.provider },
        );
        if (!isRetryable(kind) || attempt === maxRetries) throw err;
        lastErr = err;
        // Respect Retry-After when present (seconds or HTTP-date). Otherwise
        // exponential backoff with full jitter.
        const retryAfter = resp.headers.get('retry-after');
        const backoff = retryAfter && /^\d+$/.test(retryAfter)
          ? parseInt(retryAfter, 10) * 1000
          : Math.floor(Math.random() * DEFAULT_BACKOFF_BASE_MS * Math.pow(2, attempt));
        await sleep(backoff);
        continue;
      }

      return await resp.json() as T;
    } catch (raw) {
      clearTimeout(timer);
      // Already a classified EmbeddingError → rethrow / loop
      if (raw instanceof EmbeddingError) {
        if (attempt === maxRetries || !isRetryable(raw.kind)) throw raw;
        lastErr = raw;
        await sleep(Math.floor(Math.random() * DEFAULT_BACKOFF_BASE_MS * Math.pow(2, attempt)));
        continue;
      }
      // AbortError → timeout (transient)
      const err = raw as Error & { name?: string };
      const isAbort = err.name === 'AbortError';
      const kind: EmbeddingErrorKind = isAbort ? 'transient' : 'transient';
      const wrapped = new EmbeddingError(
        isAbort
          ? `${opts.provider} request timed out after ${timeoutMs}ms`
          : `${opts.provider} network error: ${err.message ?? String(raw)}`,
        { kind, provider: opts.provider, cause: raw },
      );
      if (attempt === maxRetries) throw wrapped;
      lastErr = wrapped;
      await sleep(Math.floor(Math.random() * DEFAULT_BACKOFF_BASE_MS * Math.pow(2, attempt)));
    }
  }
  // Loop exits only via return or throw; this is defensive.
  throw lastErr ?? new EmbeddingError(`${opts.provider} request failed after ${maxRetries + 1} attempts`, {
    kind: 'unknown', provider: opts.provider,
  });
}
