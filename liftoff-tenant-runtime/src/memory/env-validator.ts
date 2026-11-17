// src/memory/env-validator.ts
// D20: process-startup validation for every MEM_* / HARVEST_* env var.
// Parses to expected type, range-checks, logs and exits if invalid.

import { logger } from '../infrastructure/logging';

type RangeRule = { kind: 'float' | 'int'; min?: number; max?: number };
type BoolRule = { kind: 'bool' };
type EnumRule = { kind: 'enum'; values: string[] };
type Rule = RangeRule | BoolRule | EnumRule;

const RULES: Record<string, Rule> = {
  MEM_RECENCY_DECAY: { kind: 'float', min: 0, max: 1 },
  MEM_MIN_SIMILARITY: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_TAG: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_SEMANTIC: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_RECENCY: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_TYPE: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_FEEDBACK: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_INFLUENCE: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_SUMMARY: { kind: 'float', min: 0, max: 1 },
  MEM_WEIGHT_SOURCE_TRUST: { kind: 'float', min: 0, max: 5 },
  MEM_TOKEN_BUDGET: { kind: 'int', min: 100, max: 100000 },
  MEM_INFLUENCE_LOOKBACK_DAYS: { kind: 'int', min: 1, max: 365 },
  MEM_INFLUENCE_GUARD_HOURS: { kind: 'int', min: 1, max: 24 },
  MEM_PEER_WINDOW_HOURS: { kind: 'float', min: 0.5, max: 720 },
  MEM_PEER_MIN_USEFULNESS: { kind: 'int', min: -10, max: 100 },
  MEM_EMBEDDING_CACHE_DISABLED: { kind: 'bool' },
  MEM_EVENT_LOG_DISABLED: { kind: 'bool' },
  MEM_SUMMARIZATION_ENABLED: { kind: 'bool' },
  HARVEST_HIGH_CONFIDENCE_THRESHOLD: { kind: 'float', min: 0, max: 1 },
};

export function validateMemoryEnv(): void {
  const errors: string[] = [];

  for (const [name, rule] of Object.entries(RULES)) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;

    if (rule.kind === 'bool') {
      if (raw !== '0' && raw !== '1' && raw !== 'true' && raw !== 'false') {
        errors.push(`${name}: expected boolean '0'|'1'|'true'|'false', got '${raw}'`);
      }
      continue;
    }
    if (rule.kind === 'enum') {
      if (!rule.values.includes(raw)) {
        errors.push(`${name}: expected one of [${rule.values.join(', ')}], got '${raw}'`);
      }
      continue;
    }
    const parsed = rule.kind === 'int' ? parseInt(raw, 10) : parseFloat(raw);
    if (Number.isNaN(parsed)) {
      errors.push(`${name}: expected ${rule.kind}, got '${raw}'`);
      continue;
    }
    if (rule.min !== undefined && parsed < rule.min) {
      errors.push(`${name}: value ${parsed} below min ${rule.min}`);
    }
    if (rule.max !== undefined && parsed > rule.max) {
      errors.push(`${name}: value ${parsed} above max ${rule.max}`);
    }
  }

  if (errors.length > 0) {
    logger.error({ errors }, 'validateMemoryEnv: env-var validation failed; exiting');
    process.exit(1);
  }
  logger.info('validateMemoryEnv: all MEM_* / HARVEST_* env vars within expected ranges');
}
