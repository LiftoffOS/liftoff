// Validator Hook Types
// Per Section 17: Validator hook versions

export type ValidatorHookStatus = 'draft' | 'testing' | 'active' | 'deprecated';

export type ValidatorHookType =
  | 'pre_action'      // Validates before an action is executed
  | 'post_action'     // Validates after an action is executed
  | 'pre_write'       // Validates before writing to external system
  | 'schema'          // Validates data schema
  | 'policy'          // Validates against business policies
  | 'security'        // Security validation checks
  | 'rollout_pre_start'  // Per Section 17: Validates before rollout starts
  | 'rollout_pre_advance'; // Per Section 17: Validates before rollout step advances

export interface ValidatorHook {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  type: ValidatorHookType;
  version: number;
  status: ValidatorHookStatus;

  // Validation configuration
  config: ValidatorHookConfig;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  activatedAt: Date | null;
  deprecatedAt: Date | null;
  createdBy: string;
}

export interface ValidatorHookConfig {
  // When this hook should run
  triggerOn: ValidatorTrigger[];

  // Validation rules
  rules: ValidationRule[];

  // Error handling
  onFailure: 'block' | 'warn' | 'log';

  // Performance settings
  timeout: number; // ms
  async: boolean;  // Run asynchronously (don't block action)
}

export interface ValidatorTrigger {
  connectorType?: string;     // e.g., 'salesforce', 'zendesk'
  entityType?: string;        // e.g., 'Ticket', 'Contact'
  actionType?: string;        // e.g., 'create', 'update', 'delete'
  fieldPatterns?: string[];   // e.g., ['email*', 'phone*']

  // Per Section 17: Rollout validation triggers
  rolloutStrategy?: string;   // e.g., 'canary', 'gradual', 'immediate'
  rolloutEvent?: 'start' | 'advance' | 'complete' | 'rollback';
}

export interface ValidationRule {
  id: string;
  name: string;
  description?: string;

  // Rule type
  type: 'regex' | 'schema' | 'custom' | 'lookup' | 'expression';

  // Rule configuration
  config: Record<string, unknown>;

  // Error message when rule fails
  errorMessage: string;

  // Severity level
  severity: 'error' | 'warning' | 'info';
}

export interface ValidatorHookVersion {
  id: string;
  hookId: string;
  version: number;
  config: ValidatorHookConfig;
  status: ValidatorHookStatus;
  createdAt: Date;
  createdBy: string;
  changeLog: string;
}

export interface CreateValidatorHookInput {
  tenantId: string;
  name: string;
  description: string;
  type: ValidatorHookType;
  config: ValidatorHookConfig;
  createdBy: string;
}

export interface UpdateValidatorHookInput {
  config: ValidatorHookConfig;
  changeLog: string;
  updatedBy: string;
}

export interface ValidatorHookTestResult {
  hookId: string;
  version: number;
  passed: boolean;
  results: TestRuleResult[];
  executionTime: number;
  testedAt: Date;
}

export interface TestRuleResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  errorMessage?: string;
  matchedData?: unknown;
}
