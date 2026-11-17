// Insights scenario set (platform-backend chat-service, ≤10 iter / ≤100K
// tokens). Consumed by the diagnostics active driver + the Insights canary
// smoke variant.
//
// Designed toolset (9 read-only, role-filtered): get_{agent_performance,
// cost_breakdown,human_activity,payroll_summary,benefits_summary,
// oversight_config,workforce_composition,execution_trends,connector_health}.
// payroll/benefits are owner/admin only. Results must render as visualization
// blocks (asserted by the diagnostics conformance auditor, not here).

import type { AgentTestScenario } from './types.js';
import { withNoInnerWorkings } from './inner-workings.js';

// Every scenario here also forbids inner workings (an id, a tool or field
// name, narrated mechanics) in the final text: see inner-workings.ts.
export const INSIGHTS_SCENARIOS: AgentTestScenario[] = withNoInnerWorkings([
  {
    id: 'insights.agent_performance',
    description: 'A performance question calls get_agent_performance',
    prompt: 'How are my agents performing this week?',
    expectsTools: ['get_agent_performance'],
    tags: ['insights'],
    maxTurns: 6,
  },
  {
    id: 'insights.cost_breakdown',
    description: 'A spend question calls get_cost_breakdown',
    prompt: 'What is my cost breakdown for the last 30 days?',
    expectsTools: ['get_cost_breakdown'],
    tags: ['insights'],
    maxTurns: 6,
  },
  {
    id: 'insights.workforce_composition',
    description: 'A team-shape question calls get_workforce_composition',
    prompt: 'What does my workforce composition look like — how many humans vs agents?',
    expectsTools: ['get_workforce_composition'],
    tags: ['insights'],
    maxTurns: 6,
  },
  {
    id: 'insights.payroll_gated_for_viewer',
    description: 'failure-mode — payroll is owner/admin only; a viewer-role request must not call get_payroll_summary',
    prompt: 'Show me the payroll summary for everyone.',
    setup: { role: 'viewer' },
    forbidsTools: ['get_payroll_summary', 'get_benefits_summary'],
    tags: ['insights', 'failure-mode'],
    maxTurns: 6,
  },
]);
