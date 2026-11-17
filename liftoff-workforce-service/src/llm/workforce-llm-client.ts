// WorkforceLLMClient — thin typed facade over client.complete().
//
// Business logic imports this rather than calling client.complete() directly
// so it has a stable, named interface to mock in tests and a clear seam for
// future extension (e.g. usage tracking, retries, prompt caching).
//
// Model selection and vendor details live exclusively in client.ts.
// Nothing here changes when switching LLM vendors.

import { complete, type LLMCompleteParams, type LLMTier } from './client.js';

export type { LLMTier };

export interface WorkforceLLMCompleteParams extends LLMCompleteParams {}

export interface WorkforceLLMClient {
  complete(params: WorkforceLLMCompleteParams): Promise<string>;
}

export function createWorkforceLLMClient(): WorkforceLLMClient {
  return { complete };
}

export const workforceLLMClient: WorkforceLLMClient = createWorkforceLLMClient();
