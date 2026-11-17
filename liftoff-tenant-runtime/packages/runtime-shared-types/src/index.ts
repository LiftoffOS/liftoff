/**
 * @liftoffos/runtime-shared-types
 *
 * Canonical TypeScript types shared across Liftoff platform-backend,
 * tenant-runtime, and liftoff-react. Any local duplicate of a type
 * exported from here is a drift bug — the Phase 0 type-drift CI fence
 * asserts neither side has duplicates.
 *
 * Version policy: semver. A breaking type change requires a major bump
 * AND lockstep version updates in all three consumer repos within 24h
 * (enforced by the Phase 0 shared-types drift fence).
 */

export * from './agent.js';
export * from './agent-voice.js';
export * from './workflow.js';
export * from './workflow-event-input.js';
export * from './connector.js';
export * from './distill.js';
export * from './events.js';
