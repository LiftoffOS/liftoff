// WS-4.5 — JSON Schema constants for every Pub/Sub event type the platform
// publishes. Plain CommonJS module so consumers in both repos can require()
// it without depending on tsc output. Sibling .d.ts file carries the types.

'use strict';

const RuntimeConfigUpdatedPayloadSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    entityVersion: { type: 'number' },
    agentType: { type: 'string', enum: ['agent', 'workflow'] },
    hitlLevel: { type: 'integer', minimum: 1, maximum: 5 },
    modelConfig: { type: 'object' },
    execConfig: { type: 'object' },
    memoryScope: { type: 'object' },
    delegates: { type: 'array' },
    workflowStepsHash: { type: 'string' },
  },
  required: ['agentType', 'hitlLevel', 'modelConfig', 'execConfig', 'memoryScope'],
};

module.exports = { RuntimeConfigUpdatedPayloadSchema };
