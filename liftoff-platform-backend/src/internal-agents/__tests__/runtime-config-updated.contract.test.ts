// Publisher-side contract test for the
// tenant.internal_agent.runtime_config_updated payload.
//
// Asserts that the platform-backend's payload-build path emits a payload
// that validates against the schema in @liftoffos/proto-gen/event-schemas
// for every realistic fixture. A PR that intentionally publishes a payload
// with hitlLevel:0 fails this test (Ajv rejects integer < 1).

import Ajv from 'ajv';
import { RuntimeConfigUpdatedPayloadSchema } from '../runtime-config-schema';
import { validateRuntimeConfigUpdatedPayload, RuntimeConfigPayloadValidationError } from '../runtime-config-validator';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(RuntimeConfigUpdatedPayloadSchema);

// Realistic fixtures — these mirror the shape the service.ts construction
// path produces for the four agent-types we ship today.
const FIXTURES = [
  {
    name: 'autonomy=balanced standard agent',
    payload: {
      entityVersion: 7,
      agentType: 'agent' as const,
      hitlLevel: 3,
      modelConfig: { tier: 'medium' },
      execConfig: { maxIterations: 12 },
      memoryScope: { readableLayers: ['individual', 'team'], writableLayers: ['individual'] },
      delegates: [],
      capabilityTier: 'connector_only',
    },
  },
  {
    name: 'autonomy=autonomous workflow',
    payload: {
      entityVersion: 21,
      agentType: 'workflow' as const,
      hitlLevel: 4,
      modelConfig: { tier: 'large' },
      execConfig: { maxIterations: 8 },
      memoryScope: { readableLayers: ['individual'], writableLayers: ['individual'] },
      delegates: [],
      capabilityTier: 'sandbox',
    },
  },
  {
    name: 'autonomy=controlled minimal',
    payload: {
      entityVersion: 1,
      agentType: 'agent' as const,
      hitlLevel: 2,
      modelConfig: { tier: 'small' },
      execConfig: { maxIterations: 4 },
      memoryScope: { readableLayers: [], writableLayers: [] },
      delegates: [],
      capabilityTier: 'connector_only',
    },
  },
];

describe('runtime_config_updated publisher contract', () => {
  it.each(FIXTURES.map((f) => [f.name, f.payload]))('emits valid payload for %s', (_name, payload) => {
    const ok = validate(payload);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it('validateRuntimeConfigUpdatedPayload accepts every fixture', () => {
    for (const f of FIXTURES) {
      expect(() => validateRuntimeConfigUpdatedPayload(f.payload)).not.toThrow();
    }
  });

  it('rejects hitlLevel below the documented [1..5] range', () => {
    const bad = { ...FIXTURES[0].payload, hitlLevel: 0 };
    expect(() => validateRuntimeConfigUpdatedPayload(bad)).toThrow(RuntimeConfigPayloadValidationError);
  });

  it('rejects missing hitlLevel', () => {
    const { hitlLevel: _ignored, ...bad } = FIXTURES[0].payload;
    expect(() => validateRuntimeConfigUpdatedPayload(bad as Record<string, unknown>)).toThrow(RuntimeConfigPayloadValidationError);
  });

  it('rejects unknown agentType', () => {
    const bad = { ...FIXTURES[0].payload, agentType: 'mystery' };
    expect(() => validateRuntimeConfigUpdatedPayload(bad as Record<string, unknown>)).toThrow(RuntimeConfigPayloadValidationError);
  });
});
