import { z } from 'zod';

// Stub the connector-service-client (pulled in transitively via
// connector-capabilities → validator.ts). It depends on a proto-gen module
// path that isn't resolvable in jest without extra mapper config; we don't
// exercise it from these unit tests.
jest.mock('../../connectors/connector-service-client', () => ({}));
jest.mock('../../connectors/connector-service-cache', () => ({}));

// Reach into the validator module to grab the internal triggerConfigZodSchema
// via parsing a partial AgentTemplate. We import the public entry point so this
// test exercises the same path Zod uses in production.
import { agentTemplateZodSchema } from '../validator';

function withTrigger(triggerConfig: unknown) {
  return {
    id: 'phase-a-test',
    displayName: 'X',
    departmentCategory: 'operations',
    description: 'description',
    roleSummary: 'roleSummary',
    role: 'role',
    responsibilities: '## Responsibilities\nfoo',
    additionalContext: '## Rules\nbar',
    requiredConnectors: [],
    optionalConnectors: [],
    defaultAgentType: 'agent',
    defaultMemoryScope: {},
    defaultTriggerConfig: triggerConfig,
    schemaVersion: 1,
  };
}

describe('triggerConfig validator — companionCrons', () => {
  it('accepts up to 5 companion entries with unique labels', () => {
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'cron',
      cronExpr: '0 9 * * *',
      companionCrons: [
        { label: 'weekly', cronExpr: '0 9 * * 1' },
        { label: 'monthly', cronExpr: '0 9 1 * *' },
      ],
    }));
    expect(result.success).toBe(true);
  });

  it('rejects duplicate companion labels within the same agent', () => {
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'cron',
      cronExpr: '0 9 * * *',
      companionCrons: [
        { label: 'dup', cronExpr: '0 9 * * 1' },
        { label: 'dup', cronExpr: '0 10 * * 2' },
      ],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/unique/i);
    }
  });

  it('rejects more than 5 companions', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `c${i}`, cronExpr: '0 9 * * 1' }));
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'cron', cronExpr: '0 9 * * *', companionCrons: six,
    }));
    expect(result.success).toBe(false);
  });

  it('rejects invalid label characters (uppercase, leading digit, special chars)', () => {
    const cases = ['Bad', '1leading', 'has spaces', 'with_underscore', 'with.dot'];
    for (const label of cases) {
      const result = agentTemplateZodSchema.safeParse(withTrigger({
        type: 'cron', cronExpr: '0 9 * * *',
        companionCrons: [{ label, cronExpr: '0 9 * * 1' }],
      }));
      expect(result.success).toBe(false);
    }
  });

  it('accepts deprecated singular companionCron alone', () => {
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'cron', cronExpr: '0 9 * * *',
      companionCron: { cronExpr: '0 9 * * 1' },
    }));
    expect(result.success).toBe(true);
  });

  it('rejects setting both singular and plural companion fields', () => {
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'cron', cronExpr: '0 9 * * *',
      companionCron: { cronExpr: 'A' },
      companionCrons: [{ label: 'x', cronExpr: 'B' }],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/deprecated|companionCron/i);
    }
  });
});

describe('triggerConfig validator — reactiveSubscriptions', () => {
  it('accepts a connector_event subscription with a simple filter', () => {
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'manual',
      reactiveSubscriptions: [
        {
          label: 'old-invoices',
          source: { kind: 'connector_event', connectorRef: 'quickbooks', entityType: 'invoice' },
          filter: { op: 'gte', path: 'age_days', value: 30 },
          objective: 'Send a reminder',
        },
      ],
    }));
    expect(result.success).toBe(true);
  });

  it('rejects more than 10 subscriptions per agent', () => {
    const subs = Array.from({ length: 11 }, (_, i) => ({
      label: `s${i}`,
      source: { kind: 'connector_event', connectorRef: 'x' },
      objective: 'do',
    }));
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'manual', reactiveSubscriptions: subs,
    }));
    expect(result.success).toBe(false);
  });

  it('rejects predicates that exceed max depth (>10)', () => {
    let expr: unknown = { op: 'eq', path: 'a', value: 1 };
    for (let i = 0; i < 12; i++) expr = { op: 'not', operand: expr };
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'manual',
      reactiveSubscriptions: [{
        label: 'deep',
        source: { kind: 'connector_event', connectorRef: 'x' },
        filter: expr,
        objective: 'do',
      }],
    }));
    expect(result.success).toBe(false);
  });

  it('rejects window aggregate=avg without a field', () => {
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'manual',
      reactiveSubscriptions: [{
        label: 'win',
        source: { kind: 'connector_event', connectorRef: 'x' },
        window: { aggregate: 'avg', durationSeconds: 300, threshold: { comparator: 'gt', value: 1 } },
        objective: 'do',
      }],
    }));
    expect(result.success).toBe(false);
  });

  it('rejects computed_metric pollIntervalSeconds < 60', () => {
    const result = agentTemplateZodSchema.safeParse(withTrigger({
      type: 'manual',
      reactiveSubscriptions: [{
        label: 'cm',
        source: {
          kind: 'computed_metric',
          connectorRef: 'x',
          fn: 'getRate',
          pollIntervalSeconds: 30,
        },
        objective: 'do',
      }],
    }));
    expect(result.success).toBe(false);
  });
});

// Eliminate the unused-import warning when running tests in isolation
void z;
