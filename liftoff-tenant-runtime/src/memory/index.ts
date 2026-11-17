// Memory Module
// Per implementation plan: Phase 2 Memory System

export { memoryRouter } from './router';
export { memoryService, MemoryService } from './service';
export {
  generateEmbedding,
  generateEmbeddingDetailed,
  generateEmbeddingsBatch,
  generateEmbeddingsBatchDetailed,
  cosineSimilarity,
  ACTIVE_DIM,
  getProviderNativeDim,
  getProviderModel,
  getDefaultProvider,
  EmbeddingDimMismatchError,
} from './embedding';
export type {
  EmbeddingResult,
  EmbeddingBatchResult,
  GenerateEmbeddingOptions,
} from './embedding';
export { encryptContent, decryptContent, hashContent, isEncrypted } from './encryption';
export {
  validateMemoryContent,
  validateScopeKey,
  validateTags,
  validateLayer,
  validateContentClassification,
} from './validation';
export {
  Memory,
  MemoryLayer,
  ContentClassification,
  SaveMemoryOptions,
  RetrieveMemoryOptions,
  RetrievedMemory,
  SupersedeMemoryOptions,
  MemoryValidationError,
  MAX_CONTENT_LENGTH,
  MAX_TAGS,
  SCOPE_KEY_PATTERN,
} from './types';
