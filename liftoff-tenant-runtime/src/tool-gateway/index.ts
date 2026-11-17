// Tool Gateway Module
// Per Section 11: Tool gateway and conflict-policy registry

export * from './types';
export { ConflictPolicyRegistry } from './conflict-policy-registry';
export { ToolGatewayService } from './service';
export { ExternalStateFetcherRegistry, stateFetcherRegistry } from './state-fetcher';
export { toolGatewayRouter } from './router';
export { ExternalAgentHandler, externalAgentHandler } from './external-agent-handler';
export type {
  ExternalAgentConfig,
  ExternalAgentCredentials,
  ExternalAgentExecuteInput,
  ExternalAgentExecuteResult,
} from './external-agent-handler';
