// System-prompt template renderer.
//
// The seeded `internal_agents.system_prompt` for CAIO and HRBP is a static
// skeleton with placeholder tokens — {{TODAY}}, {{PLAN_STATE}}, {{TOOLS}}
// (CAIO) and {{TOOLS}} (HRBP). renderSystemPrompt substitutes them per turn.
//
// Plain string-replace. Tokens are chosen so they never appear elsewhere
// in the skeleton; no printf-style escaping needed.

import type { WorkforcePlan } from '../workforce-plans/types.js';

export interface RenderContext {
  /** ISO date YYYY-MM-DD. Defaults to today UTC if omitted. */
  today?: string;
  /** Pre-rendered plan-state section (or empty string if no plan attached).
   *  CAIO chat-service uses formatPlanState below; HRBP passes nothing. */
  planState?: string;
  /** Filtered tool list for the current caller. */
  tools: Array<{ name: string; description: string }>;
}

export function renderSystemPrompt(template: string, ctx: RenderContext): string {
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const planState = ctx.planState ?? '';
  const tools =
    ctx.tools.length === 0
      ? '(none — the user has no tools available)'
      : ctx.tools.map((t) => `- \`${t.name}\`: ${t.description}`).join('\n');

  return template
    .replace('{{TODAY}}', today)
    .replace('{{PLAN_STATE}}', planState)
    .replace('{{TOOLS}}', tools);
}

/** Renders the "Current Workforce Plan State" section that gets substituted
 *  into CAIO's `{{PLAN_STATE}}` token. Moved here from
 *  workforce-plans/tools/system-prompt.ts so the platform-agent module owns
 *  the full system-prompt assembly. */
export function formatPlanState(plan: WorkforcePlan): string {
  const lines: string[] = [];
  lines.push(`## Current Workforce Plan State`);
  lines.push(`- Plan id: ${plan.id}`);
  lines.push(`- Title: ${plan.title ?? '(untitled)'}`);
  lines.push(`- Status: ${plan.status}`);
  lines.push(`- Revision: ${plan.revision}`);
  lines.push(`- Agents: ${plan.agents.length}`);
  if (plan.agents.length > 0) {
    for (const spec of plan.agents) {
      const parts: string[] = [
        `  - ${spec.name} (${spec.agentType === 'workflow' ? 'Workflow' : 'Agent'}`,
      ];
      if (spec.department) parts.push(`, ${spec.department}`);
      parts.push(`): ${spec.roleSummary}`);
      lines.push(parts.join(''));
      if (spec.connectors && spec.connectors.length > 0) {
        lines.push(`    connectors: ${spec.connectors.join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}
