// Repository Validation Utilities
// Per Section 5: Input validation for database operations

import { logger } from './logging';
import { CONNECTOR_TYPES } from '@liftoffos/connector-types';

// Validation error class
export class ValidationError extends Error {
  public field: string;
  public value: unknown;

  constructor(message: string, field: string, value?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
  }
}

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Validation functions
export const validate = {
  // Validate required field
  required(value: unknown, field: string): void {
    if (value === undefined || value === null || value === '') {
      throw new ValidationError(`${field} is required`, field, value);
    }
  },

  // Validate UUID format
  uuid(value: string | undefined | null, field: string): void {
    if (value === undefined || value === null) {
      return; // Not required - use required() first if needed
    }
    if (!UUID_REGEX.test(value)) {
      throw new ValidationError(`${field} must be a valid UUID`, field, value);
    }
  },

  // Validate string length
  maxLength(value: string | undefined | null, maxLen: number, field: string): void {
    if (value && value.length > maxLen) {
      throw new ValidationError(
        `${field} must be at most ${maxLen} characters`,
        field,
        `[${value.length} chars]`
      );
    }
  },

  minLength(value: string | undefined | null, minLen: number, field: string): void {
    if (value && value.length < minLen) {
      throw new ValidationError(
        `${field} must be at least ${minLen} characters`,
        field,
        `[${value.length} chars]`
      );
    }
  },

  // Validate string matches pattern
  pattern(value: string | undefined | null, pattern: RegExp, field: string, description?: string): void {
    if (value && !pattern.test(value)) {
      throw new ValidationError(
        `${field} ${description || 'has invalid format'}`,
        field,
        value
      );
    }
  },

  // Validate enum value
  enum<T extends string>(value: string | undefined | null, allowed: readonly T[], field: string): void {
    if (value && !allowed.includes(value as T)) {
      throw new ValidationError(
        `${field} must be one of: ${allowed.join(', ')}`,
        field,
        value
      );
    }
  },

  // Validate number range
  range(value: number | undefined | null, min: number, max: number, field: string): void {
    if (value !== undefined && value !== null && (value < min || value > max)) {
      throw new ValidationError(
        `${field} must be between ${min} and ${max}`,
        field,
        value
      );
    }
  },

  // Validate positive number
  positive(value: number | undefined | null, field: string): void {
    if (value !== undefined && value !== null && value <= 0) {
      throw new ValidationError(`${field} must be positive`, field, value);
    }
  },

  // Validate non-negative number
  nonNegative(value: number | undefined | null, field: string): void {
    if (value !== undefined && value !== null && value < 0) {
      throw new ValidationError(`${field} must be non-negative`, field, value);
    }
  },

  // Validate array not empty
  arrayNotEmpty(value: unknown[] | undefined | null, field: string): void {
    if (value && value.length === 0) {
      throw new ValidationError(`${field} must not be empty`, field, value);
    }
  },

  // Validate email format
  email(value: string | undefined | null, field: string): void {
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new ValidationError(`${field} must be a valid email address`, field, value);
    }
  },

  // Validate URL format
  url(value: string | undefined | null, field: string): void {
    if (value) {
      try {
        new URL(value);
      } catch {
        throw new ValidationError(`${field} must be a valid URL`, field, value);
      }
    }
  },

  // Validate no SQL injection risk characters
  safeSqlString(value: string | undefined | null, field: string): void {
    if (value && /[';-]/.test(value)) {
      throw new ValidationError(`${field} contains invalid characters`, field, '[redacted]');
    }
  },

  // Validate JSON parseable
  jsonParseable(value: string | undefined | null, field: string): void {
    if (value) {
      try {
        JSON.parse(value);
      } catch {
        throw new ValidationError(`${field} must be valid JSON`, field, '[invalid json]');
      }
    }
  },

  // Validate date is not in past
  notInPast(value: Date | string | undefined | null, field: string): void {
    if (value) {
      const date = typeof value === 'string' ? new Date(value) : value;
      if (date < new Date()) {
        throw new ValidationError(`${field} must not be in the past`, field, value);
      }
    }
  },

  // Validate date is not in future
  notInFuture(value: Date | string | undefined | null, field: string): void {
    if (value) {
      const date = typeof value === 'string' ? new Date(value) : value;
      if (date > new Date()) {
        throw new ValidationError(`${field} must not be in the future`, field, value);
      }
    }
  },
};

// Schema validation helper
export interface FieldSchema {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'uuid' | 'email' | 'url' | 'array' | 'object';
  maxLength?: number;
  minLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  enum?: readonly string[];
}

export function validateSchema<T extends Record<string, unknown>>(
  data: T,
  schema: Record<keyof T, FieldSchema>
): void {
  for (const [field, rules] of Object.entries(schema) as [keyof T, FieldSchema][]) {
    const value = data[field];

    if (rules.required) {
      validate.required(value, field as string);
    }

    if (value === undefined || value === null) {
      continue;
    }

    if (rules.type === 'uuid') {
      validate.uuid(value as string, field as string);
    }

    if (rules.type === 'email') {
      validate.email(value as string, field as string);
    }

    if (rules.type === 'url') {
      validate.url(value as string, field as string);
    }

    if (rules.maxLength !== undefined) {
      validate.maxLength(value as string, rules.maxLength, field as string);
    }

    if (rules.minLength !== undefined) {
      validate.minLength(value as string, rules.minLength, field as string);
    }

    if (rules.min !== undefined && rules.max !== undefined) {
      validate.range(value as number, rules.min, rules.max, field as string);
    }

    if (rules.pattern) {
      validate.pattern(value as string, rules.pattern, field as string);
    }

    if (rules.enum) {
      validate.enum(value as string, rules.enum, field as string);
    }
  }
}

// Validation decorator for repository methods
export function validateInput<T extends Record<string, unknown>>(
  schema: Record<string, FieldSchema>
) {
  return function (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const input = args[0] as T;

      try {
        validateSchema(input, schema as Record<keyof T, FieldSchema>);
      } catch (error) {
        if (error instanceof ValidationError) {
          logger.warn('Repository validation failed', {
            method: propertyKey,
            field: error.field,
            message: error.message,
          });
        }
        throw error;
      }

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}

// Pre-built schemas for common entities
export const schemas = {
  workflow: {
    tenantId: { required: true, type: 'uuid' as const },
    agentId: { required: true, type: 'uuid' as const },
    objective: { required: true, type: 'string' as const, minLength: 1, maxLength: 1000 },
  },

  task: {
    workflowId: { required: true, type: 'uuid' as const },
    agentId: { required: true, type: 'uuid' as const },
    idempotencyKey: { required: true, type: 'string' as const, minLength: 1, maxLength: 255 },
  },

  action: {
    tenantId: { required: true, type: 'uuid' as const },
    workflowId: { required: true, type: 'uuid' as const },
    taskId: { required: true, type: 'uuid' as const },
    idempotencyKey: { required: true, type: 'string' as const, minLength: 1, maxLength: 255 },
    connector: { required: true, type: 'string' as const, minLength: 1, maxLength: 100 },
    entityType: { required: true, type: 'string' as const, minLength: 1, maxLength: 100 },
    actionType: { required: true, type: 'string' as const, minLength: 1, maxLength: 100 },
  },

  agent: {
    tenantId: { required: true, type: 'uuid' as const },
    name: { required: true, type: 'string' as const, minLength: 1, maxLength: 255 },
  },

  connector: {
    tenantId: { required: true, type: 'uuid' as const },
    type: {
      required: true,
      type: 'string' as const,
      enum: CONNECTOR_TYPES,
    },
    name: { required: true, type: 'string' as const, minLength: 1, maxLength: 255 },
  },
};
