// The Chief AI Officer's own tools use the product's words (platform-backend
// INV-PB-016, the same test over this service's text).
//
// The Chief AI Officer reads two things this service writes: its seeded prompt
// (platform-backend migration 509, checked there) and the definitions of the
// tools registered here, description and parameter descriptions alike. If those
// descriptions say "the team" where they mean an agent, it will tell a person
// "I bind it to the team" or "I give the team a private sandbox", because a
// model follows the demonstration over the rule. An internal agent is an "agent" or its own name, never "agent" and
// never "team" on its own (a team is people and agents together); an external
// one is an "external agent"; the people are "people".
//
// Identifiers are not prose: tool names, argument keys, enum values and anything
// in backticks are skipped. Zero tolerance, no baseline.

jest.mock('../infrastructure/config', () => ({
  loadConfig: () => ({ PLATFORM_BACKEND_URL: 'https://pb.test', WORKFORCE_SERVICE_TOKEN: 'wf-tok' }),
}));
jest.mock('../infrastructure/service-auth', () => ({
  getServiceAuthHeaders: async () => ({ 'X-Service-Auth': 'wf-tok' }),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getToolDefinitionsForRole } from '../workforce-plans/tools/index.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const BARE_TEAM = /(?<!\bAI )(?<![A-Za-z_])(?:team|teams|Team)(?![A-Za-z_])/g;
/** The retired noun. Both casings, singular and plural. */
const AI_TEAM = /\bAI teams?\b/gi;
/** The retired name for an agent from outside the workspace. */
const EXTERNAL_COLLABORATOR = /\bexternal collaborators?\b/gi;
const ALLOWED: RegExp[] = [
  /Microsoft Teams/g,
  /Teams page/g,
  /team plan/g,
  /"(?:team|teams|agent|agents|team members|AI team|AI teams|external collaborator)"/g,
  /[Aa] team is people and agents together/g,
];

function prose(text: string): string {
  let t = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const a of ALLOWED) t = t.replace(a, '');
  return t;
}

function findings(text: string): string[] {
  const t = prose(text);
  const out: string[] = [];
  for (const re of [BARE_TEAM, AI_TEAM, EXTERNAL_COLLABORATOR]) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      out.push(t.slice(Math.max(0, at - 60), at + m[0].length + 40).replace(/\n/g, ' '));
    }
  }
  return out;
}

function descriptionsOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'description' && typeof v === 'string') out.push(v);
    else out.push(...descriptionsOf(v));
  }
  return out;
}

const ROLES: WorkforcePlanToolContext['role'][] = ['owner', 'admin', 'member', 'viewer'];

describe('the Chief AI Officer\'s tools use the product\'s own words', () => {
  it('the scanner sees what it is meant to see', () => {
    // Bare "team" and the retired "agent" are both violations; "agent" is now
    // the word the product uses and must NOT be flagged.
    expect(findings('Tell the team to start the AI team.')).toHaveLength(2);
    expect(findings('Hand it to an external collaborator.')).toHaveLength(1);
    expect(findings('Tell the agent to start the agents.')).toHaveLength(0);
    // Identifiers are not prose, so `team_get`, teamId and team_status survive a
    // vocabulary change. This fixture is what proves the scanner still skips
    // identifiers, and it keeps working whether or not those symbols are renamed.
    expect(findings('Say "agent", never "team". Use `team_get`, teamId and team_status.')).toHaveLength(0);
  });

  it.each(ROLES)('every tool a %s is offered: its description and each parameter\'s', (role) => {
    for (const handover of [false, true]) {
      const defs = getToolDefinitionsForRole(role, { handover });
      expect(defs.length).toBeGreaterThan(0);
      const text = defs.map((d) => `${d.name}\n${descriptionsOf(d).join('\n')}`).join('\n');
      expect(findings(text)).toEqual([]);
    }
  });
});
