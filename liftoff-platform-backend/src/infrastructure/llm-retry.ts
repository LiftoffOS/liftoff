// Shared LLM retry utility
// Extracted from distill-service.ts to avoid duplication across capability-analyzer, tool-classifier, etc.

import { log } from './logging';

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;

// Errors that should trigger a retry (transient failures)
const RETRYABLE_ERROR_PATTERNS = [
  /timeout/i,
  /rate limit/i,
  /too many requests/i,
  /503/i,
  /502/i,
  /504/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /network/i,
  /temporarily unavailable/i,
  /overloaded/i,
];

export function isRetryableError(error: Error): boolean {
  const message = error.message || '';
  return RETRYABLE_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function calculateBackoff(attempt: number): number {
  // Exponential backoff with jitter: 2^attempt * baseDelay + random jitter
  const exponentialDelay = Math.pow(2, attempt) * BASE_DELAY_MS;
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
}

export interface RetryOptions {
  maxRetries?: number;
  context?: string; // For logging (e.g., 'distill', 'analyze', 'classify')
}

/**
 * Execute an async function with retry logic and exponential backoff.
 * Use this for all LLM calls to handle transient failures gracefully.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = MAX_RETRIES, context = 'operation' } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (!isRetryableError(lastError)) {
        log.error(
          { error: lastError.message, context, attempt: attempt + 1 },
          `${context} failed with non-retryable error`
        );
        throw lastError;
      }

      // Don't retry on last attempt
      if (attempt >= maxRetries - 1) {
        log.error(
          { error: lastError.message, context, attempt: attempt + 1, maxRetries },
          `${context} failed after all retries exhausted`
        );
        throw lastError;
      }

      // Calculate backoff delay
      const delay = calculateBackoff(attempt);
      log.warn(
        { error: lastError.message, context, attempt: attempt + 1, delayMs: delay },
        `${context} failed, retrying with backoff`
      );

      await sleep(delay);
    }
  }

  // This should never be reached due to the throw in the loop, but TypeScript needs it
  throw lastError || new Error(`${context} failed with unknown error`);
}
