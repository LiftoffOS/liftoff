// Validator Hook Service
// Per Section 17: Validator hook versions

import {
  ValidatorHook,
  ValidatorHookVersion,
  CreateValidatorHookInput,
  UpdateValidatorHookInput,
  ValidatorHookTestResult,
  TestRuleResult,
  ValidatorHookConfig,
} from './types';
import { ValidatorHookRepository } from './repository';
import { publishEvent } from '../events/publisher';
import { logger } from '../infrastructure/logging';

export class ValidatorHookService {
  private repository = new ValidatorHookRepository();

  async list(tenantId?: string): Promise<ValidatorHook[]> {
    return this.repository.findAll(tenantId);
  }

  async getById(id: string): Promise<ValidatorHook | null> {
    return this.repository.findById(id);
  }

  async getActive(tenantId: string): Promise<ValidatorHook[]> {
    return this.repository.findActive(tenantId);
  }

  async getByType(tenantId: string, type: string): Promise<ValidatorHook[]> {
    return this.repository.findByType(tenantId, type);
  }

  async create(input: CreateValidatorHookInput): Promise<ValidatorHook> {
    // Check for duplicate name
    const existing = await this.repository.findByTenantAndName(input.tenantId, input.name);
    if (existing) {
      throw new Error(`Validator hook with name '${input.name}' already exists`);
    }

    // Validate config
    this.validateConfig(input.config);

    const hook = await this.repository.create(input);

    logger.info('Created validator hook', {
      id: hook.id,
      tenantId: hook.tenantId,
      name: hook.name,
      type: hook.type,
    });

    await publishEvent({
      entityType: 'validator_hook',
      entityId: hook.id,
      eventType: 'tenant.validator_hook.created',
      entityVersion: hook.version,
      eventVersion: 1,
      tenantId: hook.tenantId,
      payload: {
        name: hook.name,
        type: hook.type,
        version: hook.version,
      },
    });

    return hook;
  }

  async update(id: string, input: UpdateValidatorHookInput): Promise<ValidatorHook> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new Error(`Validator hook ${id} not found`);
    }

    // Cannot update active hooks directly - must create new version
    if (existing.status === 'active') {
      throw new Error('Cannot modify active hook. Create a new version instead.');
    }

    // Validate config
    this.validateConfig(input.config);

    const hook = await this.repository.update(
      id,
      input.config,
      input.changeLog,
      input.updatedBy
    );

    logger.info('Updated validator hook', {
      id: hook.id,
      version: hook.version,
      updatedBy: input.updatedBy,
    });

    await publishEvent({
      entityType: 'validator_hook',
      entityId: hook.id,
      eventType: 'tenant.validator_hook.updated',
      entityVersion: hook.version,
      eventVersion: 1,
      tenantId: hook.tenantId,
      payload: {
        name: hook.name,
        type: hook.type,
        version: hook.version,
        changeLog: input.changeLog,
      },
    });

    return hook;
  }

  async startTesting(id: string): Promise<ValidatorHook> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new Error(`Validator hook ${id} not found`);
    }

    if (existing.status !== 'draft') {
      throw new Error(`Can only start testing from draft status, current: ${existing.status}`);
    }

    const hook = await this.repository.updateStatus(id, 'testing');

    logger.info('Started testing validator hook', { id, version: hook.version });

    return hook;
  }

  async activate(id: string): Promise<ValidatorHook> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new Error(`Validator hook ${id} not found`);
    }

    if (existing.status !== 'testing') {
      throw new Error(`Can only activate from testing status, current: ${existing.status}`);
    }

    const hook = await this.repository.updateStatus(id, 'active');

    logger.info('Activated validator hook', { id, version: hook.version });

    await publishEvent({
      entityType: 'validator_hook',
      entityId: hook.id,
      eventType: 'tenant.validator_hook.activated',
      entityVersion: hook.version,
      eventVersion: 1,
      tenantId: hook.tenantId,
      payload: {
        name: hook.name,
        type: hook.type,
        version: hook.version,
        activatedAt: hook.activatedAt,
      },
    });

    return hook;
  }

  async deprecate(id: string): Promise<ValidatorHook> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new Error(`Validator hook ${id} not found`);
    }

    const hook = await this.repository.updateStatus(id, 'deprecated');

    logger.info('Deprecated validator hook', { id, version: hook.version });

    await publishEvent({
      entityType: 'validator_hook',
      entityId: hook.id,
      eventType: 'tenant.validator_hook.deprecated',
      entityVersion: hook.version,
      eventVersion: 1,
      tenantId: hook.tenantId,
      payload: {
        name: hook.name,
        type: hook.type,
        version: hook.version,
      },
    });

    return hook;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new Error(`Validator hook ${id} not found`);
    }

    if (existing.status === 'active') {
      throw new Error('Cannot delete active hook. Deprecate it first.');
    }

    await this.repository.delete(id);

    logger.info('Deleted validator hook', { id });
  }

  // Version management

  async getVersions(hookId: string): Promise<ValidatorHookVersion[]> {
    return this.repository.findVersions(hookId);
  }

  async getVersion(hookId: string, version: number): Promise<ValidatorHookVersion | null> {
    return this.repository.findVersion(hookId, version);
  }

  async rollback(hookId: string, version: number, rolledBackBy: string): Promise<ValidatorHook> {
    const hook = await this.repository.rollbackToVersion(hookId, version, rolledBackBy);

    logger.info('Rolled back validator hook', {
      id: hookId,
      toVersion: version,
      newVersion: hook.version,
      rolledBackBy,
    });

    await publishEvent({
      entityType: 'validator_hook',
      entityId: hook.id,
      eventType: 'tenant.validator_hook.rolled_back',
      entityVersion: hook.version,
      eventVersion: 1,
      tenantId: hook.tenantId,
      payload: {
        name: hook.name,
        rolledBackToVersion: version,
        newVersion: hook.version,
      },
    });

    return hook;
  }

  // Testing

  async test(id: string, testData: unknown): Promise<ValidatorHookTestResult> {
    const hook = await this.repository.findById(id);
    if (!hook) {
      throw new Error(`Validator hook ${id} not found`);
    }

    const startTime = Date.now();
    const results: TestRuleResult[] = [];

    for (const rule of hook.config.rules) {
      const result = this.evaluateRule(rule, testData);
      results.push(result);
    }

    const executionTime = Date.now() - startTime;
    const passed = results.every((r) => r.passed || r.errorMessage === undefined);

    logger.info('Tested validator hook', {
      id,
      version: hook.version,
      passed,
      executionTime,
      rulesEvaluated: results.length,
    });

    return {
      hookId: id,
      version: hook.version,
      passed,
      results,
      executionTime,
      testedAt: new Date(),
    };
  }

  private evaluateRule(rule: any, data: unknown): TestRuleResult {
    try {
      switch (rule.type) {
        case 'regex':
          return this.evaluateRegexRule(rule, data);
        case 'schema':
          return this.evaluateSchemaRule(rule, data);
        case 'expression':
          return this.evaluateExpressionRule(rule, data);
        default:
          return {
            ruleId: rule.id,
            ruleName: rule.name,
            passed: true,
            matchedData: data,
          };
      }
    } catch (error) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        passed: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private evaluateRegexRule(rule: any, data: unknown): TestRuleResult {
    const pattern = new RegExp(rule.config.pattern, rule.config.flags || '');
    const value = this.extractValue(data, rule.config.field);

    if (typeof value !== 'string') {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        passed: false,
        errorMessage: `Field '${rule.config.field}' is not a string`,
      };
    }

    const passed = pattern.test(value);
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      passed,
      errorMessage: passed ? undefined : rule.errorMessage,
      matchedData: value,
    };
  }

  private evaluateSchemaRule(rule: any, data: unknown): TestRuleResult {
    // Basic schema validation
    const requiredFields = rule.config.requiredFields || [];
    const dataObj = data as Record<string, unknown>;

    for (const field of requiredFields) {
      if (!(field in dataObj) || dataObj[field] === undefined || dataObj[field] === null) {
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          passed: false,
          errorMessage: `Required field '${field}' is missing`,
        };
      }
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      passed: true,
      matchedData: data,
    };
  }

  private evaluateExpressionRule(rule: any, data: unknown): TestRuleResult {
    // Simple expression evaluation (field comparisons)
    const expression = rule.config.expression as string;

    // Parse simple comparisons like "field > value" or "field == value"
    const match = expression.match(/^(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)$/);
    if (!match) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        passed: false,
        errorMessage: `Invalid expression: ${expression}`,
      };
    }

    const [, field, operator, compareValue] = match;
    const fieldValue = this.extractValue(data, field);

    let passed = false;
    const parsedCompareValue = this.parseValue(compareValue);

    switch (operator) {
      case '==':
        passed = fieldValue === parsedCompareValue;
        break;
      case '!=':
        passed = fieldValue !== parsedCompareValue;
        break;
      case '>':
        passed = Number(fieldValue) > Number(parsedCompareValue);
        break;
      case '<':
        passed = Number(fieldValue) < Number(parsedCompareValue);
        break;
      case '>=':
        passed = Number(fieldValue) >= Number(parsedCompareValue);
        break;
      case '<=':
        passed = Number(fieldValue) <= Number(parsedCompareValue);
        break;
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      passed,
      errorMessage: passed ? undefined : rule.errorMessage,
      matchedData: { field: fieldValue, compareValue: parsedCompareValue },
    };
  }

  private extractValue(data: unknown, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = data;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  private parseValue(value: string): unknown {
    const trimmed = value.trim();

    // String literal
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1);
    }

    // Boolean
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    // Number
    const num = Number(trimmed);
    if (!isNaN(num)) return num;

    // Null
    if (trimmed === 'null') return null;

    return trimmed;
  }

  // Per Section 17: Invoke rollout hooks during rollout lifecycle
  async invokeRolloutHooks(
    tenantId: string,
    hookType: 'rollout_pre_start' | 'rollout_pre_advance',
    rolloutData: {
      rolloutId: string;
      modelId: string;
      strategy: string;
      currentStep?: number;
      currentPercentage?: number;
      nextPercentage?: number;
      metrics?: {
        errorRate?: number;
        p99LatencyMs?: number;
        requestCount?: number;
      };
    }
  ): Promise<{
    passed: boolean;
    blockers: Array<{ hookId: string; hookName: string; errors: string[] }>;
    warnings: Array<{ hookId: string; hookName: string; warnings: string[] }>;
  }> {
    const hooks = await this.repository.findByType(tenantId, hookType);
    const activeHooks = hooks.filter((h) => h.status === 'active');

    if (activeHooks.length === 0) {
      logger.debug('No active rollout hooks found', { tenantId, hookType });
      return { passed: true, blockers: [], warnings: [] };
    }

    const blockers: Array<{ hookId: string; hookName: string; errors: string[] }> = [];
    const warnings: Array<{ hookId: string; hookName: string; warnings: string[] }> = [];

    for (const hook of activeHooks) {
      // Check if this hook applies to the rollout strategy
      const trigger = hook.config.triggerOn.find((t) =>
        !t.rolloutStrategy || t.rolloutStrategy === rolloutData.strategy
      );

      if (!trigger) {
        continue; // Hook doesn't apply to this rollout strategy
      }

      // Evaluate all rules
      const hookErrors: string[] = [];
      const hookWarnings: string[] = [];

      for (const rule of hook.config.rules) {
        const result = this.evaluateRule(rule, rolloutData);

        if (!result.passed) {
          if (rule.severity === 'error') {
            hookErrors.push(result.errorMessage || rule.errorMessage);
          } else if (rule.severity === 'warning') {
            hookWarnings.push(result.errorMessage || rule.errorMessage);
          }
        }
      }

      if (hookErrors.length > 0) {
        blockers.push({
          hookId: hook.id,
          hookName: hook.name,
          errors: hookErrors,
        });
      }

      if (hookWarnings.length > 0) {
        warnings.push({
          hookId: hook.id,
          hookName: hook.name,
          warnings: hookWarnings,
        });
      }
    }

    // If any hooks with onFailure='block' generated errors, the check fails
    const passed = blockers.length === 0;

    logger.info('Invoked rollout hooks', {
      tenantId,
      hookType,
      rolloutId: rolloutData.rolloutId,
      hooksEvaluated: activeHooks.length,
      passed,
      blockerCount: blockers.length,
      warningCount: warnings.length,
    });

    return { passed, blockers, warnings };
  }

  // Convenience method for pre-start validation
  async validateRolloutStart(
    tenantId: string,
    rolloutData: {
      rolloutId: string;
      modelId: string;
      strategy: string;
    }
  ): Promise<{
    passed: boolean;
    blockers: Array<{ hookId: string; hookName: string; errors: string[] }>;
    warnings: Array<{ hookId: string; hookName: string; warnings: string[] }>;
  }> {
    return this.invokeRolloutHooks(tenantId, 'rollout_pre_start', rolloutData);
  }

  // Convenience method for pre-advance validation
  async validateRolloutAdvance(
    tenantId: string,
    rolloutData: {
      rolloutId: string;
      modelId: string;
      strategy: string;
      currentStep: number;
      currentPercentage: number;
      nextPercentage: number;
      metrics?: {
        errorRate?: number;
        p99LatencyMs?: number;
        requestCount?: number;
      };
    }
  ): Promise<{
    passed: boolean;
    blockers: Array<{ hookId: string; hookName: string; errors: string[] }>;
    warnings: Array<{ hookId: string; hookName: string; warnings: string[] }>;
  }> {
    return this.invokeRolloutHooks(tenantId, 'rollout_pre_advance', rolloutData);
  }

  private validateConfig(config: ValidatorHookConfig): void {
    if (!config.triggerOn || config.triggerOn.length === 0) {
      throw new Error('At least one trigger is required');
    }

    if (!config.rules || config.rules.length === 0) {
      throw new Error('At least one validation rule is required');
    }

    if (!['block', 'warn', 'log'].includes(config.onFailure)) {
      throw new Error('Invalid onFailure value');
    }

    if (typeof config.timeout !== 'number' || config.timeout < 0) {
      throw new Error('Invalid timeout value');
    }

    for (const rule of config.rules) {
      if (!rule.id || !rule.name || !rule.type) {
        throw new Error('Each rule must have id, name, and type');
      }
      if (!['regex', 'schema', 'custom', 'lookup', 'expression'].includes(rule.type)) {
        throw new Error(`Invalid rule type: ${rule.type}`);
      }
      if (!['error', 'warning', 'info'].includes(rule.severity)) {
        throw new Error(`Invalid severity: ${rule.severity}`);
      }
    }
  }
}
