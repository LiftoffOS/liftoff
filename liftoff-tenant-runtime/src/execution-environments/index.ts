// Execution Environments Module
// Separate from connectors — execution environments provision ephemeral compute,
// not external API calls.

export { SandboxExecutor } from './sandbox-executor';
export type { SandboxSession, SandboxToolCallInput, SandboxToolCallResult } from './sandbox-executor';
export { CloudRunSandboxProvider } from './cloud-run-sandbox-provider';
export type { CloudRunSandboxProviderConfig } from './cloud-run-sandbox-provider';
export { SandboxStateRepository } from './sandbox-state-repository';
export { SandboxUsageRepository } from './usage-repository';
export { SandboxAuditRepository } from './audit-repository';
export { SandboxOutputSanitizer } from './output-sanitizer';
export { SandboxRateLimiter } from './rate-limiter';
export { CredentialVendingService } from './credential-vending-service';
export type { ConnectorCredentialProvider } from './credential-vending-service';
export { createExecutionEnvironmentsRouter } from './router';
export { InstanceAliveTicker } from './instance-alive-ticker';
export type { UsageRecorder, UsageLedger } from './instance-alive-ticker';
export { calculateSandboxCredits, getDefaultSandboxCreditCost } from './credit-calculator';
export type { CreditCostProvider } from './credit-calculator';
export { validateWorkspacePath, validateBranchName, validateCommitMessage, filterSecretFiles, PathTraversalError, ValidationError } from './path-validator';
export { AutonomousLoopController } from './loop-controller';
export type { LoopConfig, LoopState, IterationResult, LoopStatus } from './loop-controller';
export * from './types';
