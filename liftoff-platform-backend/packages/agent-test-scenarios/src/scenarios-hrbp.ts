// HRBP scenario set (workforce-service runPlatformAgent, autonomous). Consumed
// by the diagnostics active driver + the HRBP canary smoke variant.
//
// Designed toolset (6 fixed): teambuilder__distill → teambuilder__create →
// provisioning__{record_event,update_spec_status}; provisioning__compensate
// (rollback); provisioning__transition_to_blocker (terminator). Designed
// sequence + terminal-state correctness is the core check.

import type { AgentTestScenario } from './types.js';

export const HRBP_SCENARIOS: AgentTestScenario[] = [
  {
    id: 'hrbp.distill_then_create',
    description: 'Provisioning a spec distills then creates the internal agent, in order',
    prompt: 'Provision the approved spec for a "support-triage" agent.',
    expectsTools: ['teambuilder__distill', 'teambuilder__create'],
    tags: ['hrbp'],
    maxTurns: 8,
  },
  {
    id: 'hrbp.records_provisioning',
    description: 'A successful create records a provisioning event / updates spec status',
    prompt: 'Provision the approved spec and record its provisioning status.',
    expectsOneOf: [['provisioning__record_event', 'provisioning__update_spec_status']],
    expectsTools: ['teambuilder__create'],
    tags: ['hrbp'],
    maxTurns: 8,
  },
  {
    id: 'hrbp.blocker_terminates',
    description: 'failure-mode — an unrecoverable spec transitions to blocker (terminator)',
    prompt: 'Provision this spec that references a connector the tenant has not authorized.',
    expectsTools: ['provisioning__transition_to_blocker'],
    tags: ['hrbp', 'failure-mode'],
    maxTurns: 8,
  },
  {
    id: 'hrbp.compensate_on_partial_failure',
    description: 'failure-mode — a partial-create failure compensates (rolls back)',
    prompt: 'Provision this spec; if creation half-completes, undo it.',
    expectsTools: ['provisioning__compensate'],
    tags: ['hrbp', 'failure-mode'],
    maxTurns: 8,
  },
];
