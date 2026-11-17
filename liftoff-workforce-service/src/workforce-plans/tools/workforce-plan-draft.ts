// workforce_plan__draft Tool
//
// Creates a new draft plan or updates the draft currently attached to the
// chat thread. The CAIO calls this after gathering enough context from the
// user to propose an agent spec (or to iterate on one). Each call replaces
// the plan's agents array atomically - the CAIO always passes the full
// current spec set, not a patch.
//
// The plan id returned by the first call is carried forward on the chat
// context (ctx.workforcePlanId), so subsequent calls in the same thread
// update the same plan instead of creating new ones. The thread-plan link
// is established by the chat service when the first draft is created.
//
// Adapted from platform-backend src/workforce-plans/tools/workforce-plan-draft.ts.
// Import paths use .js extensions (ESM). Local service and chat-repository.

import { workforcePlanService } from '../service.js';
import { composeAdditionalContext, composeResponsibilities } from '../agent-prose.js';
import { refuseExecutionMechanics } from '../prose-for-the-person.js';
import { linkWorkforcePlan } from '../chat-repository.js';
import { listTenantAgents } from '../tenant-agents.js';
import { detectRosterDuplicates, renderDuplicateGuidance, type DuplicateMatch } from '../roster-dedup.js';
import { log } from '../../infrastructure/logging.js';
import type {
  OrgChart,
  WorkforcePlanAgentSpec,
} from '../types.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface DraftInput {
  title?: string;
  agents: WorkforcePlanAgentSpec[];
  orgChart?: OrgChart;
}

interface DraftOutput {
  planId: string;
  status: string;
  title: string | null;
  agentCount: number;
  revision: number;
  message: string;
  /** Proposed specs that overlap an existing team, so the CAIO routes to it
   *  rather than provisioning a duplicate. Empty when the plan is clean or the
   *  roster could not be read (a failed lookup is never a duplicate). */
  duplicateWarnings: DuplicateMatch[];
}

/** The draft was not written: its prose names how the platform does the work,
 *  which the person reads. The error says which field and phrase, and what to
 *  write instead. */
interface DraftRefused {
  ok: false;
  error: string;
}

export const workforcePlanDraftTool: WorkforcePlanTool = {
  definition: {
    name: 'workforce_plan__draft',
    description:
      'Create or update a workforce plan draft. Call this once the user has described their needs and you have concrete agent specifications to propose. Each call replaces the plan\'s entire `agents` array - always pass the full current spec set. If a draft is already attached to this conversation, this updates it; otherwise it creates a new one. Returns the plan id and current agent count. The result also returns duplicateWarnings: proposed agents that overlap an agent the workspace already has. When it flags a duplicate, do NOT provision a second agent - route to the existing one (team__get_config then team__propose_update to change it) or drop the spec and tell the user it already exists. Never transitions the plan beyond draft - use workforce_plan__commit when the user has confirmed the plan is ready for approval.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short human-readable title for the plan (e.g. "Customer Ops agents" or "Q2 AI workforce"). Max 500 chars.',
        },
        agents: {
          type: 'array',
          description: 'The full list of agent specifications (1-50 items). Each entry describes one agent to provision.',
          items: {
            type: 'object',
            properties: {
              specId: {
                type: 'string',
                description: 'Stable identifier for this spec across drafts. Use a short slug like "customer-success-01".',
              },
              name: {
                type: 'string',
                description: 'Human-readable agent name.',
              },
              agentType: {
                type: 'string',
                enum: ['agent', 'workflow'],
                description: '`agent` = dynamic LLM loop (best for advisory or task work), `workflow` = predetermined step graph (best for cron-driven data movement).',
              },
              department: {
                type: 'string',
                description: 'Department this agent belongs to.',
              },
              roleSummary: {
                type: 'string',
                description: 'One to two sentence summary of the agent\'s role.',
              },
              prose: {
                type: 'object',
                description:
                  'The agent brief, one field per section. Write each section as plain prose with NO markdown heading — the headings are added for you. If the user already described the work in these terms, carry their wording across rather than rewriting it; their detail (exact URLs, field mappings, ordering rules, failure handling) is the point. '
                  + 'These fields are what the person reads and edits on the agent\'s page, so they are written in the person\'s terms: what the agent does, for whom, when, with what rules and limits, and what the result looks like. Never say how the platform does the work — which tool reads a page, whether a run uses a browser or a session, how a site is reached, or any tool or vendor name. Execution is decided when the agent is built, from what the platform offers then; a draft that names a mechanic is refused with the field and phrase to rewrite.',
                properties: {
                  responsibilities: { type: 'string', description: 'What this agent owns, day to day.' },
                  goals: { type: 'string', description: 'What good looks like — the outcome the agent is accountable for.' },
                  workflows: { type: 'string', description: 'The steps the agent works through, in order. Keep numbered steps, field mappings and exact URLs verbatim.' },
                  instructions: { type: 'string', description: 'Standing instructions: where to write, what never to do, formats to use.' },
                  outcomes: { type: 'string', description: 'The end state after a successful run.' },
                  specificInstructions: { type: 'string', description: 'Operating detail that is not a responsibility.' },
                  rules: { type: 'string', description: 'Hard rules the agent must follow.' },
                  constraints: { type: 'string', description: 'Limits on scope, volume, or cost.' },
                  edgeCases: { type: 'string', description: 'Known awkward cases and how to handle them.' },
                  anythingToAvoid: { type: 'string', description: 'Behaviours to avoid.' },
                },
              },
              connectors: {
                type: 'array',
                items: { type: 'string' },
                description: 'Connector type names this agent should use (e.g. ["google_calendar", "hubspot"]). Check connectors__list_available first.',
              },
            },
            required: ['specId', 'name', 'agentType', 'roleSummary'],
          },
        },
        orgChart: {
          type: 'object',
          description: 'Optional org chart showing how the agents relate. Nodes are the agents (plus the people they report to); edges define reporting lines.',
          properties: {
            nodes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  type: { type: 'string' },
                  department: { type: 'string' },
                },
                required: ['id', 'label'],
              },
            },
            edges: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  label: { type: 'string' },
                },
                required: ['from', 'to'],
              },
            },
          },
          required: ['nodes', 'edges'],
        },
      },
      required: ['agents'],
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<DraftOutput | DraftRefused> {
    const input = rawInput as unknown as DraftInput;

    // The person's layer stays in the person's terms. Checked per spec on the
    // slots as written, so the refusal names the section the author filled.
    for (const spec of input.agents ?? []) {
      const refusal = refuseExecutionMechanics({
        roleSummary: spec.roleSummary,
        ...(spec.prose ?? {}),
        ...(spec.responsibilities ? { responsibilities: spec.responsibilities } : {}),
        ...(spec.additionalContext ? { additionalContext: spec.additionalContext } : {}),
      });
      if (refusal) return { ok: false, error: `${spec.name ?? spec.specId}: ${refusal}` };
    }

    // Render the two markdown fields from the section slots the model filled.
    // Doing it here means every spec that reaches the plan — and therefore the
    // distiller and the created agent — is in canonical shape by construction.
    const agents = (input.agents ?? []).map(spec => {
      const slots = spec.prose;
      if (!slots) return spec;
      const responsibilities = composeResponsibilities(slots);
      const additionalContext = composeAdditionalContext(slots);
      return {
        ...spec,
        ...(responsibilities ? { responsibilities } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      };
    });

    // Structural dedup: before this plan can provision a team the workspace
    // already runs, match every proposed spec against the live roster and, on
    // an overlap, direct the CAIO to route to the existing team instead. The
    // CAIO can already see the roster and is told to avoid duplicates, but that
    // is prompt-only; this makes the check fire on the draft itself. Best
    // effort: a roster read that fails is a lookup failure, never evidence of a
    // duplicate, so the draft is never blocked or delayed by it.
    let duplicateWarnings: DuplicateMatch[] = [];
    try {
      const roster = await listTenantAgents(ctx.tenantId);
      if (roster.ok) {
        duplicateWarnings = detectRosterDuplicates(agents, roster.agents, ctx.workforcePlanId);
      }
    } catch (err) {
      log.warn(
        { event: 'workforce_plan_draft_dedup_failed', tenantId: ctx.tenantId, error: (err as Error).message },
        'draft dedup check failed — proceeding without a duplicate warning',
      );
    }
    const dedupNote = renderDuplicateGuidance(duplicateWarnings);

    // If the thread already has a plan attached and that plan is still
    // being shaped, update it in place. A plan that has finished (completed
    // or failed) is history: the conversation goes on, and the next plan the
    // person asks for is a new one on the same thread. A DM with the Chief AI
    // Officer is one conversation for as long as the workspace exists, so a
    // thread that could hold only its first plan would build exactly one team
    // and then send the person elsewhere to build the second.
    const attached = ctx.workforcePlanId
      ? await workforcePlanService.getPlan(ctx.workforcePlanId, ctx.tenantId).catch(() => null)
      : null;
    const finished = attached?.status === 'completed' || attached?.status === 'failed';
    if (ctx.workforcePlanId && !finished) {
      const updated = await workforcePlanService.updateDraft(
        ctx.workforcePlanId,
        ctx.tenantId,
        {
          title: input.title,
          agents,
          orgChart: input.orgChart ?? null,
        },
      );
      return {
        planId: updated.id,
        status: updated.status,
        title: updated.title,
        agentCount: updated.agents.length,
        revision: updated.revision,
        message: `Updated draft plan with ${updated.agents.length} agent${updated.agents.length === 1 ? '' : 's'}.${dedupNote}`,
        duplicateWarnings,
      };
    }

    const created = await workforcePlanService.createDraft({
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      title: input.title ?? null,
      agents,
      orgChart: input.orgChart ?? null,
      // Wire the plan back to the originating chat thread so amendment and
      // audit views can jump from plan -> conversation without a reverse
      // lookup. The chat service also links the other direction via
      // team_plan_threads.workforce_plan_id after this tool returns.
      threadId: ctx.threadId ?? null,
    });

    // Link the new plan back to the thread so the chat service's next turn
    // can load plan state into the context. A finished plan the thread held
    // before stays in the workspace's plan history; the thread now points at
    // the one being shaped.
    if (ctx.threadId) {
      await linkWorkforcePlan(ctx.threadId, ctx.tenantId, created.id);
    }

    return {
      planId: created.id,
      status: created.status,
      title: created.title,
      agentCount: created.agents.length,
      revision: created.revision,
      message: `Created draft plan with ${created.agents.length} agent${created.agents.length === 1 ? '' : 's'}. Present the summary to the user and ask if they want to proceed.${dedupNote}`,
      duplicateWarnings,
    };
  },
};
