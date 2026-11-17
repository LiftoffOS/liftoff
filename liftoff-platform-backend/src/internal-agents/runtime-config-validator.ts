// WS-4.3 — publisher-side validator for the
// tenant.internal_agent.runtime_config_updated payload.
//
// The TR subscriber reads payload.hitlLevel and previously fell into the
// `|| null` falsy-coercion trap that wrote null into agents.hitl_level
// (NOT NULL). The fix has two halves: subscriber defaults (WS-4.1) and
// publisher validation (here). This validator runs BEFORE any inline-publish
// and throws on any malformed payload so a publisher bug surfaces at the API
// layer rather than at the subscriber's DLQ.

import Ajv from 'ajv';
import { RuntimeConfigUpdatedPayloadSchema } from './runtime-config-schema';
import { log } from '../infrastructure/logging';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(RuntimeConfigUpdatedPayloadSchema);

export class RuntimeConfigPayloadValidationError extends Error {
  constructor(message: string, public readonly errors: unknown) {
    super(message);
    this.name = 'RuntimeConfigPayloadValidationError';
  }
}

export function validateRuntimeConfigUpdatedPayload(payload: Record<string, unknown>): void {
  if (!validate(payload)) {
    log.error(
      { event: 'published_event_validation_failed', event_type: 'runtime_config_updated', errors: validate.errors },
      'runtime_config_updated payload failed schema validation',
    );
    throw new RuntimeConfigPayloadValidationError(
      `runtime_config_updated payload schema validation failed: ${ajv.errorsText(validate.errors)}`,
      validate.errors,
    );
  }
}
