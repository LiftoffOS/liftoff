export { embeddingClient, EmbeddingClient } from './client';
export {
  OpenAIEmbeddingProvider,
  GoogleEmbeddingProvider,
  VoyageEmbeddingProvider,
} from './providers';
export { EmbeddingError, WELL_KNOWN_PROVIDERS } from './types';
export type {
  EmbedCall,
  EmbeddingProvider,
  WellKnownEmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingProviderClient,
  EmbeddingProviderCapabilities,
  EmbeddingUsageEvent,
  EmbeddingUsageCallback,
  EmbeddingTaskType,
  EmbeddingErrorKind,
} from './types';
export type { EmbeddingClientInitConfig } from './client';
export type { GoogleEmbeddingProviderConfig } from './providers/google';
