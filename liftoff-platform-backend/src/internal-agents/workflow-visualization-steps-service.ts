// Workflow Visualization Steps Service
// Generates display-only workflow steps for the AgentWorkflowViz UI component.
// Runs a trailing Haiku call after agent creation/update; best-effort, nullable.

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';
import { withTenantScope } from '../infrastructure/database';
import type { WorkflowVisualizationStep } from './types';

/** The executable steps, as the diagram generator needs to see them. */
export interface VisualizationSourceStep {
  stepId: string;
  description?: string;
  type?: string;
  toolName?: string;
}

/** The steps rendered for the prompt. Trimmed: the generator needs to know WHAT
 *  each step is, not how it is configured. */
function stepList(steps: VisualizationSourceStep[]): string {
  return steps
    .map((s) => `  ${s.stepId}  ${s.type ?? 'tool_call'}${s.toolName ? `  ${s.toolName}` : ''}  ${(s.description ?? '').slice(0, 160)}`)
    .join('\n');
}

// The rules half of the prompt, kept in its own constant message.
//
// The cache breakpoint is NOT here. It is on the user turn below, so the cached
// prefix is the rules AND the agent's own inputs — the whole request.
//
// That is the opposite of the usual placement, and it is what this caller needs.
// A conversation marks its system prompt because the part before the mark is
// what two different conversations share. This is not a conversation: it is a
// single-shot call made TWICE with byte-identical inputs, seconds apart — once
// by the distill route so the Optimize response can show the chart immediately,
// and once by the fire-and-forget writer that persists it after create/update.
// The whole request is the repeated part, so the whole request is what to cache.
//
// Marking only these rules put the breakpoint at about 450 tokens, far under any
// vendor floor, so no cache entry was ever written and the pair of calls each
// paid full price. Moving the mark to the turn makes the whole request the
// cacheable prefix, which is the correct placement for a repeated single-shot
// call.
//
// IT STILL CACHES NOTHING, and that is not a defect here. The small tier
// resolves to Haiku 4.5, whose minimum cacheable prompt is 4,096 tokens
// (per the vendor's table — the widely-remembered 2,048 is Haiku 3.5,
// retired). This call's prompts typically sit under that floor, and the vendor
// documents the resulting signature — no error, both cache counters zero — as
// "shorter than the minimum".
//
// So the mark is correctly placed and inert. It costs nothing, states the
// intent, and starts paying the day the prompt grows or the tier moves. What it
// is NOT is evidence that this call is cached, and a comment claiming otherwise
// would send the next reader hunting for a bug that is a vendor floor.
//
// The executable-step rules are stated unconditionally and scoped by their own
// opening sentence rather than being spliced in only when a graph exists. Two
// variants of this text would be two prefixes, each cached against half the
// traffic, and a step-less agent already read the stepId in the example format.
const DIAGRAM_SYSTEM_PROMPT = `
You are generating a visual workflow diagram for an AI agent.

The message that follows carries the agent's role, its system prompt, its task
instructions, and — when the agent has one — the executable steps it really runs.

WHEN THE AGENT'S ACTUAL EXECUTABLE STEPS ARE LISTED, your diagram DESCRIBES
THOSE. It is not a picture of what this role usually involves, and not what the
instructions imply ought to happen — it is those steps, which are what will
really run:

- Every node MUST carry "stepId", copied EXACTLY from the list you were given,
  naming the step that node depicts.
- NEVER emit a node for something that is not in the list, however strongly the
  instructions suggest it. If the instructions say a change "needs a person to
  look", that is a sentence the agent WRITES, not a step where it finds someone:
  unless a step in the list does the finding, there is no node for it.
- You may cover several consecutive steps with one node when they are one idea;
  give it the stepId of the first of them.
- You may leave a step out to keep the picture readable. Inventing one is the
  error; omitting one is a judgement call.

Output a JSON array of workflow steps as a top-down flowchart. Rules:
- Each step label: max 5 words, plain-English action verb (Fetch, Send, Write, Detect, Evaluate, Post, Notify...)
- id: short kebab-case ("fetch-pr-diff", "post-comment")
- Only add a fork node when there is a genuine conditional branch with meaningfully different paths
- Fork condition labels: max 4 words starting with "if" ("if tests pass", "if high-risk")
- Fork paths each have their own steps array (same label rules apply)

Return ONLY a raw JSON array — no markdown, no explanation, no wrapping object. Example format:
[{"id":"fetch-data","stepId":"s1","label":"Fetch latest data"},{"id":"check-result","stepId":"s2","label":"Evaluate result","fork":{"paths":[{"condition":"if success","steps":[{"id":"send-report","stepId":"s3","label":"Send summary report"}]},{"condition":"if failure","steps":[{"id":"notify-error","stepId":"s4","label":"Notify team of error"}]}]}}]
`.trim();

/** Everything that differs between two agents. Nothing constant belongs here:
 *  a rule written into this message is a rule re-sent on every call. */
const USER_PROMPT = (
  role: string,
  systemPrompt: string | null,
  userInstructions: string | null,
  steps: VisualizationSourceStep[] | null,
) => `
Agent role: ${role}
System prompt: ${systemPrompt ?? '(none)'}
Task instructions: ${userInstructions ?? '(none)'}
${steps && steps.length > 0 ? `
THE AGENT'S ACTUAL EXECUTABLE STEPS:

${stepList(steps)}
` : ''}
`.trim();

// Pure LLM call — returns steps without writing to DB.
// Used by the distill endpoint so the Optimize response includes the chart immediately.
export async function computeWorkflowVisualizationSteps(
  role: string,
  systemPrompt: string | null,
  userInstructions: string | null,
  workflowSteps: VisualizationSourceStep[] | null = null,
): Promise<WorkflowVisualizationStep[] | null> {
  // 8192 because fork-heavy roles routinely produced 1500-3000 tokens of
  // indented JSON and silently truncated at the prior 1024 cap, leaving rows
  // with workflow_visualization_steps = NULL forever (the writer is fire-and-
  // forget — no retry, no metric). Haiku 4.5 supports up to 64k output tokens.
  const response = await llmClient.complete(
    {
      tier: 'small',
      maxTokens: 8192,
      temperature: 0,
      messages: [
        { role: 'system', content: DIAGRAM_SYSTEM_PROMPT },
        // The breakpoint, on the LAST message: the cached prefix is everything
        // up to and including it, which here is the entire request. See the
        // note on DIAGRAM_SYSTEM_PROMPT for why this caller wants that and a
        // conversation does not.
        {
          role: 'user',
          content: USER_PROMPT(role, systemPrompt, userInstructions, workflowSteps),
          cacheControl: { type: 'ephemeral' },
        },
      ],
    },
    undefined,
    { purpose: 'workflow_visualization_steps_generation' },
  );

  const raw = response.content;
  if (!raw) return null;

  // Strip code fences, then extract the outermost balanced [...] array.
  // A greedy regex like /\[[\s\S]*\]/ breaks when the LLM adds trailing text
  // containing ']' — it over-extends and produces invalid JSON. The balanced
  // extractor tracks bracket depth to find exactly the closing bracket.
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const extracted = extractOutermostArray(stripped);
  if (!extracted) {
    log.warn({ rawPreview: stripped.slice(0, 300) }, 'computeWorkflowVisualizationSteps: no JSON array found in response');
    return null;
  }

  try {
    const parsed = JSON.parse(extracted);
    if (!Array.isArray(parsed)) return null;
    // Telling the model not to invent a step is not the same as it not doing so.
    // The prompt above is the cooperative half; this is the half that holds.
    return groundToGraph(parsed as WorkflowVisualizationStep[], workflowSteps);
  } catch {
    log.warn({ rawPreview: extracted.slice(0, 300) }, 'computeWorkflowVisualizationSteps: JSON.parse failed');
    return null;
  }
}

// Finds the first complete, balanced [...] array in a string by tracking bracket depth.
function extractOutermostArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// Computes and persists steps to DB. Used as a fire-and-forget after create/update.
export async function generateWorkflowVisualizationSteps(
  agentId: string,
  tenantId: string,
  role: string,
  systemPrompt: string | null,
  userInstructions: string | null,
  workflowSteps: VisualizationSourceStep[] | null = null,
): Promise<void> {
  const steps = await computeWorkflowVisualizationSteps(
    role, systemPrompt, userInstructions, workflowSteps,
  );
  if (!steps) {
    log.warn({ agentId }, 'generateWorkflowVisualizationSteps: no steps generated');
    return;
  }

  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE internal_agents SET workflow_visualization_steps = $1 WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify(steps), agentId, tenantId],
  ));

  // Surfaces the silent-success path so truncation regressions don't hide for
  // weeks. Pair with the existing warn-on-failure log to track success rate.
  log.info({ agentId, stepCount: steps.length }, 'generateWorkflowVisualizationSteps: persisted');
}

/**
 * Drop every node that does not name a real step.
 *
 * WHY THIS EXISTS AND NOT JUST THE PROMPT
 *
 * The prompt already tells the model, twice and in capitals, to describe only
 * the steps it was given. A model can still ignore an instruction just as
 * explicit: a code reviewer's diagram can draw "Find senior engineer" -> "Hand
 * off to senior" while the very instructions it was handed say "do not name an
 * individual and do not route the review anywhere". Unless something checks
 * the picture against the graph, the dashboard describes a handoff that can
 * never happen and no test can know.
 *
 * An instruction is a hope about the model. This is a fact about the output.
 *
 * NOT ENFORCED WHEN THERE IS NO GRAPH. An agent with no workflowSteps has
 * nothing to be checked against, and demanding a stepId there would delete
 * every diagram it has. Those keep today's behaviour, ungrounded — the same
 * choice `verify-migrations.sh` makes with its INCONCLUSIVE exit: a check that
 * could not run knows nothing.
 *
 * Prunes rather than rejects. One invented node among ten real ones should cost
 * that node, not the whole picture; a fork path emptied by pruning is dropped,
 * and a fork left with no paths becomes a plain node. Only when nothing at all
 * survives does it return null, which is the "no diagram" the callers already
 * handle.
 */
export function groundToGraph(
  nodes: WorkflowVisualizationStep[],
  workflowSteps: VisualizationSourceStep[] | null,
): WorkflowVisualizationStep[] | null {
  if (!workflowSteps || workflowSteps.length === 0) return nodes;

  const real = new Set(workflowSteps.map((s) => s.stepId));
  const dropped: string[] = [];

  const walk = (list: WorkflowVisualizationStep[]): WorkflowVisualizationStep[] =>
    list.reduce<WorkflowVisualizationStep[]>((kept, node) => {
      if (!node?.stepId || !real.has(node.stepId)) {
        dropped.push(node?.label ?? '(unlabelled)');
        return kept;
      }
      const paths = (node.fork?.paths ?? [])
        .map((p) => ({ ...p, steps: walk(p.steps ?? []) }))
        .filter((p) => p.steps.length > 0);
      kept.push(paths.length > 0 ? { ...node, fork: { paths } } : { ...node, fork: undefined });
      return kept;
    }, []);

  const grounded = walk(nodes);

  if (dropped.length > 0) {
    // Logged loudly: every line here is the generator describing work the agent
    // does not do, which is the drift this function exists to bound.
    log.warn(
      { droppedLabels: dropped.slice(0, 20), droppedCount: dropped.length, keptCount: grounded.length },
      'workflow visualization: dropped nodes that name no executable step',
    );
  }
  return grounded.length > 0 ? grounded : null;
}
