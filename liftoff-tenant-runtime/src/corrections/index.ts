// Correction Protocol Module for Tenant Runtime
// Per implementation plan: Exports for correction execution on execution plane

// Types
export * from './types';

// Pub/Sub subscriber for correction events
export { initCorrectionSubscriber } from './subscriber';

// Correction executor
export { executeCorrection } from './executor';

// Pre-action state resolution
export { getPreActionSnapshot, getPreActionSnapshotWithValidation } from './state-resolver';

// Rate-limited queue execution
export { enqueueCorrection } from './queue';

// Resource validation
export { validateResourceExists, isNotFoundError } from './resource-validator';

// Dead-letter queue handling
export {
  sendToDeadLetterQueue,
  reportCorrectionFailure,
  reportCorrectionTimeout,
  processDLQMessage,
} from './dlq-handler';

// Control plane API client
export {
  createCorrectionAuditLog,
  getAuditLog,
  getCorrectionRegistryEntry,
} from './control-plane-client';
