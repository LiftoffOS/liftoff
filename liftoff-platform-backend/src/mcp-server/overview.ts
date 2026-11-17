// The overview a coding tool receives when it connects: this person's
// workspace, in their terms, ahead of the standing instructions.
//
// Per person, not per server: the workspace's name, the AI workforce by name
// and status, what waits on this person (omitted for a viewer, who cannot
// act), their four most recent conversations with links, and — for an owner
// whose workspace is not set up — what remains and where. Every section is a
// separate read under Promise.allSettled; one that fails is left out rather
// than failing the connection. No ids, about 1,500 characters at most, and the
// static text is what a caller with no resolvable actor gets.

import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { listAiWorkforce, teamDisplayName } from '../workspace-actions/teams';
import type { McpActor } from './actor';
import { listConversations } from './service';
import { SERVER_INSTRUCTIONS } from './server-instructions';

const MAX_OVERVIEW_CHARS = 1500;

const ONBOARDING_STEPS: Array<{ id: string; label: string }> = [
  { id: 'welcome', label: 'welcome' },
  { id: 'workspace_name', label: 'name the workspace' },
  { id: 'persona', label: 'say who you are' },
  { id: 'plan', label: 'choose a plan' },
  { id: 'payment', label: 'add a payment method' },
  { id: 'invite', label: 'invite colleagues' },
];

interface TenantRow {
  name: string;
  onboarding_completed_at: Date | null;
  onboarding_step_id: string | null;
}

function remainingOnboardingSteps(stepId: string | null): string[] {
  const index = stepId ? ONBOARDING_STEPS.findIndex((s) => s.id === stepId) : -1;
  return ONBOARDING_STEPS.slice(Math.max(0, index)).map((s) => s.label);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export async function buildInstructions(actor: McpActor): Promise<string> {
  const { tenantId } = actor;
  const isViewer = actor.role === 'viewer';

  const [tenant, teams, pending, conversations] = await Promise.allSettled([
    // tenants is a platform-global (non-RLS) table — default pool.
    pool.query<TenantRow>(`SELECT name, onboarding_completed_at, onboarding_step_id FROM tenants WHERE id = $1`, [tenantId])
      .then((r) => r.rows[0] ?? null),
    listAiWorkforce(tenantId),
    isViewer ? Promise.resolve(null) : tenantRuntimeClient.getPendingApprovalCount(tenantId),
    listConversations({ limit: 4 }, actor) as Promise<{ conversations?: Array<{ title: string | null; link: string; team?: { name: string }; assistant?: { name: string }; waitingOnHuman: boolean }> }>,
  ]);

  const lines: string[] = [];

  const tenantRow = tenant.status === 'fulfilled' ? tenant.value : null;
  const displayName = actor.displayName || 'You';
  lines.push(
    tenantRow
      ? `${displayName} (${actor.role}) is connected to the Liftoff workspace "${tenantRow.name}" through ${actor.client || 'this tool'}.`
      : `${displayName} (${actor.role}) is connected to their Liftoff workspace through ${actor.client || 'this tool'}.`,
  );

  if (tenantRow && tenantRow.onboarding_completed_at === null && actor.role === 'owner') {
    const remaining = remainingOnboardingSteps(tenantRow.onboarding_step_id);
    lines.push(`This workspace is not set up yet. Remaining: ${remaining.join(', ')}. Setup happens at /onboarding on the dashboard; the assistants can explain but not complete it.`);
  }

  if (teams.status === 'fulfilled') {
    const aiWorkforce = teams.value;
    if (aiWorkforce.teams.length === 0 && aiWorkforce.collaborators.length === 0) {
      lines.push('No agents yet. "Liftoff" is the place to start: it can bring in the Chief AI Officer to design the first one.');
    } else {
      const teamText = aiWorkforce.teams
        .slice(0, 12)
        .map((t) => `${teamDisplayName(t)} (${t.status})`)
        .join(', ');
      const more = aiWorkforce.teams.length > 12 ? ` and ${aiWorkforce.teams.length - 12} more` : '';
      if (aiWorkforce.teams.length > 0) lines.push(`agents: ${teamText}${more}.`);
      if (aiWorkforce.collaborators.length > 0) {
        lines.push(`External agents (systems the teams work with, not conversation partners): ${aiWorkforce.collaborators.slice(0, 8).map((c) => c.name).join(', ')}.`);
      }
    }
  }

  if (pending.status === 'fulfilled' && pending.value && pending.value.total > 0) {
    const n = pending.value.total;
    lines.push(`${n} item${n === 1 ? '' : 's'} in the review queue ${n === 1 ? 'is' : 'are'} waiting on a person. Ask "Liftoff" to review what is waiting.`);
  }

  if (conversations.status === 'fulfilled' && Array.isArray(conversations.value.conversations) && conversations.value.conversations.length > 0) {
    const recent = conversations.value.conversations.map((c) => {
      const who = c.team?.name ?? c.assistant?.name ?? 'a team';
      const title = c.title ? clip(c.title, 60) : 'Untitled';
      return `${title} (${who}${c.waitingOnHuman ? ', waiting on a person' : ''}) ${c.link}`;
    });
    lines.push(`Recent conversations, most recent first, each with the link that opens it in Liftoff:\n- ${recent.join('\n- ')}`);
  }

  for (const [name, outcome] of [['tenant', tenant], ['teams', teams], ['pending', pending], ['conversations', conversations]] as const) {
    if (outcome.status === 'rejected') {
      log.warn({ tenantId, section: name, error: (outcome.reason as Error)?.message }, 'mcp overview: section left out');
    }
  }

  const overview = clip(lines.join('\n'), MAX_OVERVIEW_CHARS);
  return `${overview}\n\n${SERVER_INSTRUCTIONS}`;
}
