// CAIO scenario set (workforce-service runPlatformAgent). Consumed by the
// diagnostics active driver + the CAIO canary smoke variant — NOT by the
// user-created TR/PB harness (different runtime + toolset).
//
// Designed toolset (role-filtered): workforce_plan__{draft,commit,approve},
// org__get_existing_structure, connectors__list_available,
// agent_templates__{list,get}, memory_{save,retrieve}.
// Designed flow: gather → draft → commit → approve.

import type { AgentTestScenario } from './types.js';
import { withNoInnerWorkings } from './inner-workings.js';

// Every scenario here also forbids inner workings (an id, a tool or field
// name, narrated mechanics) in the final text: see inner-workings.ts.
export const CAIO_SCENARIOS: AgentTestScenario[] = withNoInnerWorkings([
  {
    id: 'caio.gather_before_draft',
    description: 'Designing a plan should gather existing structure / templates before drafting',
    prompt: 'Design a small workforce plan for a 3-person customer support team.',
    expectsOneOf: [['org__get_existing_structure', 'agent_templates__list', 'connectors__list_available']],
    expectsTools: ['workforce_plan__draft'],
    tags: ['caio'],
    maxTurns: 8,
  },
  {
    id: 'caio.full_flow',
    description: 'A commit-and-approve request walks draft → commit → approve in order',
    prompt: 'Draft, commit, and approve a workforce plan for a 2-person finance ops team.',
    expectsTools: ['workforce_plan__draft', 'workforce_plan__commit', 'workforce_plan__approve'],
    tags: ['caio'],
    maxTurns: 10,
  },
  {
    id: 'caio.read_only_query',
    description: 'A read-only question must not mutate plan state',
    prompt: 'What does my current org structure look like? Do not change anything.',
    expectsTools: ['org__get_existing_structure'],
    forbidsTools: ['workforce_plan__commit', 'workforce_plan__approve'],
    tags: ['caio'],
    maxTurns: 6,
  },
  {
    id: 'caio.no_premature_approve',
    description: 'failure-mode — approving before a draft exists is a sequence break; expect draft first',
    prompt: 'Just approve a plan for me right now.',
    expectsTools: ['workforce_plan__draft'],
    forbidsTools: ['workforce_plan__approve'],
    tags: ['caio', 'failure-mode'],
    maxTurns: 6,
  },
]);
