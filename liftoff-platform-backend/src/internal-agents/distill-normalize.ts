// Deterministic repair of distillation output, applied before validation.
//
// We generate an agent's instructions rather than having a person type them,
// which creates a failure mode hand-authored frameworks do not have: OUR OWN
// generator can emit content that violates OUR OWN contracts, and it does so
// more often as the requested workflow gets more ambitious. When that happened
// the create returned a bare 400 and the person was left on a screen where the
// button had stopped spinning and nothing else had changed.
//
// The pattern is taken from two of the reference implementations rather than
// invented here:
//   - hermes-agent `agent/moonshot_schema.py::_repair_schema` rewrites LLM output
//     to satisfy the consumer's stricter schema (adding a missing `type`, moving
//     `type` off an `anyOf` parent, adding an empty `required`) instead of
//     failing the request.
//   - openclaw `packages/normalization-core` coerces whatever arrives into the
//     contract shape at the boundary — `normalizeOptionalString`, number and
//     boolean coercion — so downstream code never sees a malformed value.
//
// Repairs must PRESERVE INTENT. Coercing a type, minting a missing id, and
// dropping `null` where `undefined` is meant all leave the author's meaning
// intact. Shortening authored text does not, so this module never trims: an
// over-long description stays over-long and is reported by validateWorkflowSteps,
// which feeds the existing retry-with-feedback loop. A distillation that cannot
// be repaired still falls back to dropping `workflowSteps` and running the
// pure-LLM loop, where the agent retains its full system prompt, user
// instructions and skills.
//
// Applied at the BOUNDARY — the moment the tool call is parsed, before any
// consumer reads a field. That placement is deliberate: applying it partway
// through left `triggerConfig`, `skills` and `integrationConfigs` still reading
// the raw payload, so three of the six fields the distiller emits were repaired
// and three were not, which is the harder bug to see. `capabilityTier` and
// `absorption` need nothing here — they are computed locally by the service, not
// read from the model's output at all.
//
// No LLM call, no I/O, no failure mode of its own.

import { log } from '../infrastructure/logging';

/** One applied repair, logged so generator drift stays visible. */
interface Repair {
  field: string;
  reason: string;
}

/** Optional string fields the distiller may legitimately emit as null. Sending
 *  null where the schema says `.optional()` is what broke team creation earlier:
 *  zod's `.optional()` accepts undefined and rejects null. */
const NULLABLE_STRING_FIELDS = [
  'summary',
  'systemPrompt',
  'userInstructions',
  'instructionsMd',
] as const;

/** Coerce a primitive the model stringified (or numbered) back to a string.
 *  Mirrors openclaw's `normalizeStringifiedOptionalString`. */
function coerceToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

function coerceToNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function coerceToBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Numeric and boolean fields on a workflow step, per workflowStepSchema. */
const STEP_NUMBER_FIELDS = ['timeoutMs'] as const;
const STEP_BOOLEAN_FIELDS = ['requiresApproval', 'semanticValidation'] as const;

/** Strip every `null`-valued key from an object, in place on a copy.
 *  `null` is the single most common contract violation from the generator: it
 *  means "absent" to a model and is rejected outright by zod's `.optional()`. */
function dropNullKeys(source: Record<string, unknown>, path: string, repairs: Repair[]): Record<string, unknown> {
  const out = { ...source };
  for (const [key, value] of Object.entries(out)) {
    if (value === null) {
      delete out[key];
      repairs.push({ field: `${path}.${key}`, reason: 'null — key removed' });
    }
  }
  return out;
}

/** Booleans on a skill, per skillObjectSchema. Text lengths are NOT touched:
 *  the generator's own caps (name 80, description 300, instruction 1500) are
 *  stricter than the persisted ones (255 / 1000 / 10000), so a skill cannot
 *  arrive over-long by the same route a workflow step could. */
const SKILL_BOOLEAN_FIELDS = ['protected', 'archived'] as const;

/**
 * Repair one skill, or return null to drop it.
 *
 * `skillObjectSchema` requires a non-empty name, description and instruction. A
 * skill missing one of those carries no retrievable content — its description is
 * the semantic retrieval key, so a skill without one can never be selected at
 * runtime anyway. Dropping it costs one instruction module; failing the array
 * costs the entire distillation.
 */
function normalizeSkill(raw: unknown, index: number, repairs: Repair[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    repairs.push({ field: `skills[${index}]`, reason: 'not an object — dropped' });
    return null;
  }
  let skill = dropNullKeys(raw as Record<string, unknown>, `skills[${index}]`, repairs);

  for (const field of ['name', 'description', 'instruction'] as const) {
    const coerced = coerceToString(skill[field]);
    if (coerced === undefined || coerced.trim() === '') {
      repairs.push({ field: `skills[${index}].${field}`, reason: 'missing or empty — skill dropped' });
      return null;
    }
    if (typeof skill[field] !== 'string') {
      skill[field] = coerced;
      repairs.push({ field: `skills[${index}].${field}`, reason: 'coerced to string' });
    }
  }

  for (const field of SKILL_BOOLEAN_FIELDS) {
    if (skill[field] !== undefined && typeof skill[field] !== 'boolean') {
      const coerced = coerceToBoolean(skill[field]);
      if (coerced === undefined) {
        delete skill[field];
        repairs.push({ field: `skills[${index}].${field}`, reason: 'uncoercible — removed' });
      } else {
        skill[field] = coerced;
        repairs.push({ field: `skills[${index}].${field}`, reason: 'coerced to boolean' });
      }
    }
  }

  // `tags` is an array of strings; one non-string element rejects the whole
  // skill, and a tag is a relevance hint — the cheapest thing in the payload to
  // lose.
  if (skill.tags !== undefined) {
    if (!Array.isArray(skill.tags)) {
      skill = { ...skill };
      delete skill.tags;
      repairs.push({ field: `skills[${index}].tags`, reason: 'not an array — removed' });
    } else {
      const coercedTags = skill.tags
        .map(tag => coerceToString(tag))
        .filter((tag): tag is string => tag !== undefined && tag.trim() !== '');
      if (coercedTags.length !== skill.tags.length) {
        repairs.push({ field: `skills[${index}].tags`, reason: 'dropped unusable tags' });
      }
      skill.tags = coercedTags;
    }
  }

  return skill;
}

/**
 * Repair one workflow step in place-safe fashion.
 *
 * Returns `null` when the step cannot be made usable, so the caller drops that
 * step rather than failing the entire array — losing one malformed step leaves a
 * workflow the runtime can still execute, whereas rejecting the array costs the
 * whole distillation.
 */
function normalizeStep(
  raw: unknown,
  index: number,
  repairs: Repair[],
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    repairs.push({ field: `workflowSteps[${index}]`, reason: 'not an object — dropped' });
    return null;
  }
  const step = { ...(raw as Record<string, unknown>) };

  // stepId is referenced by onSuccess/onFailure and by the runtime's step
  // lookup, so a missing one makes the step unaddressable. Minting a stable id
  // is preferable to discarding the author's step.
  const stepId = coerceToString(step.stepId);
  if (!stepId || stepId.trim() === '') {
    step.stepId = `step-${index + 1}`;
    repairs.push({ field: `workflowSteps[${index}].stepId`, reason: 'missing — minted' });
  } else if (typeof step.stepId !== 'string') {
    step.stepId = stepId;
    repairs.push({ field: `workflowSteps[${index}].stepId`, reason: 'coerced to string' });
  }

  // A step with no description carries no instruction at all; there is nothing
  // to preserve and nothing to execute.
  const description = coerceToString(step.description);
  if (description === undefined || description.trim() === '') {
    repairs.push({
      field: `workflowSteps[${index}].description`,
      reason: 'missing or empty — step dropped',
    });
    return null;
  }
  if (typeof step.description !== 'string') {
    step.description = description;
    repairs.push({ field: `workflowSteps[${index}].description`, reason: 'coerced to string' });
  }
  // NOTE: length is deliberately NOT touched here. Trimming would make the save
  // succeed while changing what the agent does; validateWorkflowSteps reports it
  // so the model can restate the objective itself.

  for (const field of STEP_NUMBER_FIELDS) {
    if (step[field] !== undefined && typeof step[field] !== 'number') {
      const coerced = coerceToNumber(step[field]);
      if (coerced === undefined) {
        delete step[field];
        repairs.push({ field: `workflowSteps[${index}].${field}`, reason: 'uncoercible — removed' });
      } else {
        step[field] = coerced;
        repairs.push({ field: `workflowSteps[${index}].${field}`, reason: 'coerced to number' });
      }
    }
  }

  for (const field of STEP_BOOLEAN_FIELDS) {
    if (step[field] !== undefined && typeof step[field] !== 'boolean') {
      const coerced = coerceToBoolean(step[field]);
      if (coerced === undefined) {
        delete step[field];
        repairs.push({ field: `workflowSteps[${index}].${field}`, reason: 'uncoercible — removed' });
      } else {
        step[field] = coerced;
        repairs.push({ field: `workflowSteps[${index}].${field}`, reason: 'coerced to boolean' });
      }
    }
  }

  // `null` on an optional field is rejected by zod's `.optional()`. Dropping the
  // key says the same thing the model meant and passes validation.
  for (const [key, value] of Object.entries(step)) {
    if (value === null) {
      delete step[key];
      repairs.push({ field: `workflowSteps[${index}].${key}`, reason: 'null — key removed' });
    }
  }

  return step;
}

/**
 * Normalise a raw distillation payload so a contract violation from our own
 * generator is repaired rather than surfaced to the person as a failed create.
 *
 * Mutates nothing: returns a repaired shallow copy.
 */
export function normalizeDistillOutput(
  raw: Record<string, unknown>,
  context?: { tenantId?: string },
): Record<string, unknown> {
  const repairs: Repair[] = [];
  const out: Record<string, unknown> = { ...raw };

  for (const field of NULLABLE_STRING_FIELDS) {
    if (out[field] === null) {
      delete out[field];
      repairs.push({ field, reason: 'null — key removed' });
    } else if (out[field] !== undefined && typeof out[field] !== 'string') {
      const coerced = coerceToString(out[field]);
      if (coerced === undefined) {
        delete out[field];
        repairs.push({ field, reason: 'uncoercible — removed' });
      } else {
        out[field] = coerced;
        repairs.push({ field, reason: 'coerced to string' });
      }
    }
  }

  if (Array.isArray(out.workflowSteps)) {
    const normalized = out.workflowSteps
      .map((step, index) => normalizeStep(step, index, repairs))
      .filter((step): step is Record<string, unknown> => step !== null);
    out.workflowSteps = normalized.length > 0 ? normalized : undefined;
    if (normalized.length === 0 && (raw.workflowSteps as unknown[]).length > 0) {
      repairs.push({
        field: 'workflowSteps',
        reason: 'every step unusable — omitted so the agent runs the pure-LLM loop',
      });
    }
  } else if (out.workflowSteps !== undefined && out.workflowSteps !== null) {
    delete out.workflowSteps;
    repairs.push({ field: 'workflowSteps', reason: 'not an array — removed' });
  } else if (out.workflowSteps === null) {
    delete out.workflowSteps;
    repairs.push({ field: 'workflowSteps', reason: 'null — key removed' });
  }

  // ── skills ───────────────────────────────────────────────────────────────
  if (Array.isArray(out.skills)) {
    const normalized = out.skills
      .map((skill, index) => normalizeSkill(skill, index, repairs))
      .filter((skill): skill is Record<string, unknown> => skill !== null);
    // An empty array and an absent one mean the same thing downstream, and the
    // consumer already defaults to `[]`.
    out.skills = normalized;
  } else if (out.skills !== undefined) {
    const wasNull = out.skills === null;
    delete out.skills;
    repairs.push({ field: 'skills', reason: wasNull ? 'null — key removed' : 'not an array — removed' });
  }

  // ── triggerConfig ────────────────────────────────────────────────────────
  //
  // Shape repairs only. `type` is an enum and `cronExpr` is required when it is
  // 'cron' — but inventing a schedule the person never asked for would be a
  // repair that changes meaning, which is the one thing this module must not do.
  // A missing cronExpr stays missing and is caught by the structural analyzer,
  // which feeds the retry loop.
  if (out.triggerConfig !== null && typeof out.triggerConfig === 'object' && !Array.isArray(out.triggerConfig)) {
    const trigger = dropNullKeys(out.triggerConfig as Record<string, unknown>, 'triggerConfig', repairs);
    for (const field of ['type', 'cronExpr', 'eventTopic'] as const) {
      if (trigger[field] !== undefined && typeof trigger[field] !== 'string') {
        const coerced = coerceToString(trigger[field]);
        if (coerced === undefined) {
          delete trigger[field];
          repairs.push({ field: `triggerConfig.${field}`, reason: 'uncoercible — removed' });
        } else {
          trigger[field] = coerced;
          repairs.push({ field: `triggerConfig.${field}`, reason: 'coerced to string' });
        }
      }
    }
    out.triggerConfig = trigger;
  } else if (out.triggerConfig !== undefined) {
    const wasNull = out.triggerConfig === null;
    delete out.triggerConfig;
    repairs.push({ field: 'triggerConfig', reason: wasNull ? 'null — key removed' : 'not an object — removed' });
  }

  // ── integrationConfigs ───────────────────────────────────────────────────
  //
  // A per-connector record whose inner shapes vary by connector, so this only
  // removes the `null`s that zod rejects and leaves the contents alone. Guessing
  // at a connector's config would be inventing configuration.
  if (out.integrationConfigs !== null && typeof out.integrationConfigs === 'object' && !Array.isArray(out.integrationConfigs)) {
    out.integrationConfigs = dropNullKeys(
      out.integrationConfigs as Record<string, unknown>,
      'integrationConfigs',
      repairs,
    );
  } else if (out.integrationConfigs !== undefined) {
    const wasNull = out.integrationConfigs === null;
    delete out.integrationConfigs;
    repairs.push({
      field: 'integrationConfigs',
      reason: wasNull ? 'null — key removed' : 'not an object — removed',
    });
  }

  // ── capabilityNeeds ──────────────────────────────────────────────────────
  //
  // The distiller's own equipment assessment. Coerce the boolean; drop the
  // object when unusable. Absence is safe — consumers treat a missing
  // assessment as "no workspace declared" and the other tier signals still
  // apply — so repair never invents a capability the model did not claim.
  if (out.capabilityNeeds !== null && typeof out.capabilityNeeds === 'object' && !Array.isArray(out.capabilityNeeds)) {
    const needs = dropNullKeys(out.capabilityNeeds as Record<string, unknown>, 'capabilityNeeds', repairs);
    if (needs.workspace !== undefined && typeof needs.workspace !== 'boolean') {
      const coerced = coerceToBoolean(needs.workspace);
      if (coerced === undefined) {
        delete needs.workspace;
        repairs.push({ field: 'capabilityNeeds.workspace', reason: 'uncoercible — removed' });
      } else {
        needs.workspace = coerced;
        repairs.push({ field: 'capabilityNeeds.workspace', reason: 'coerced to boolean' });
      }
    }
    out.capabilityNeeds = needs;
  } else if (out.capabilityNeeds !== undefined) {
    const wasNull = out.capabilityNeeds === null;
    delete out.capabilityNeeds;
    repairs.push({ field: 'capabilityNeeds', reason: wasNull ? 'null — key removed' : 'not an object — removed' });
  }

  if (repairs.length > 0) {
    log.warn(
      {
        metric: 'distill.repaired',
        tenantId: context?.tenantId,
        repairCount: repairs.length,
        repairs: repairs.slice(0, 50),
      },
      'distill output repaired before validation',
    );
  }

  return out;
}
