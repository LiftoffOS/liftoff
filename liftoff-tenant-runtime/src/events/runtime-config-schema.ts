// WS-4.5 — JSON Schema constant for tenant.internal_agent.runtime_config_updated.
//
// The canonical home for this constant is
// `@liftoffos/proto-gen/event-schemas` (ships with
// proto-gen v0.6.0). Until the published proto-gen version reaches this
// repo's lockfile, the constant lives here. Migration to the proto package
// is a one-line import swap with no behavior change.

// $schema intentionally omitted: default Ajv ships draft-07 only, and this
// schema uses no draft-2020-12-specific keywords. Validates identically
// under draft-07. Migrate to Ajv2020 when we adopt a 2020-only keyword.
export const RuntimeConfigUpdatedPayloadSchema = {
  type: 'object',
  properties: {
    entityVersion: { type: 'number' },
    agentType: { type: 'string', enum: ['agent', 'workflow'] },
    hitlLevel: { type: 'integer', minimum: 1, maximum: 5 },
    modelConfig: { type: 'object' },
    execConfig: { type: 'object' },
    memoryScope: { type: 'object' },
    // The steps and their hash travel together or the hash means nothing. A
    // schema that carries only the hash leaves `agents.workflow_steps`
    // unpopulated, and the structured-execution branch never fires.
    workflowSteps: { type: 'array' },
    workflowStepsHash: { type: 'string' },
  },
  required: ['agentType', 'hitlLevel', 'modelConfig', 'execConfig', 'memoryScope'],
} as const;
