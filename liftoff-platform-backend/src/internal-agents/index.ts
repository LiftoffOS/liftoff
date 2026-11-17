// Internal Agents Module
// Manages internal agent configurations (UI: "Agents")

export { internalAgentsRouter, internalAgentsServiceRouter } from './router';
export { distillRouter } from './distill-router';
export { distillInternalAgentStreamRouter } from './distill-stream-router';
export { internalAgentService } from './service';
export { distillInternalAgent, distillInternalAgentWithProgress } from './distill-service';
export type { DistillStage, ProgressCallback } from './distill-service';
export { publishInternalAgentEvent } from './events';
export type {
  InternalAgent,
  InternalAgentStatus,
  CreateInternalAgentInput,
  UpdateInternalAgentInput,
  PaginatedInternalAgentsResponse,
  InternalAgentAuditEntry,
} from './types';
