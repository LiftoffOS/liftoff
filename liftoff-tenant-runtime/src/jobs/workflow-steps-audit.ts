// Would each agent's stored workflow actually run?
//
// `validateWorkflowGraph` answers that, but only completely when it is given the
// agent's real tool catalog — the `UNRESOLVABLE_TOOL` check compares each step's
// `toolName` against the set the agent would hold at execution time. That set is
// not a column anywhere. It is assembled per invocation from connector manifests
// fetched over gRPC, the connector instances THIS agent is bound to, its
// capability tier, and per-tenant vendor flags. So the question cannot be
// answered by a query; it needs the catalog built, which only the runtime can do.
//
// WHY IT MATTERS. With structured execution ON (`WORKFLOW_STEPS_ENABLED=1`, set
// in cloudbuild) these graphs are dispatched, not merely stored. Tool names
// embed connector INSTANCE ids —
// `google-sheets-2b820bc9__batch_get_values` — so a single reconnect mints a new
// id and every step naming the old one becomes UNRESOLVABLE_TOOL. The runtime
// fails the whole run on that, not the step.
//
// Check the flag, not this comment: `git log -S WORKFLOW_STEPS_ENABLED`.
//
// A NOTE ON READING ITS OUTPUT. A catalog built from integrations read in the
// wrong place has no connector tools, so every connector step looks broken and
// the UNRESOLVABLE_TOOL findings are entirely false. A tool verdict is only as
// good as the catalog behind it,
// which is why `toolCatalogChecked` is reported per agent and counted separately
// in the summary. Treat a tool finding with `toolCatalogChecked: false` as a
// statement about this job, not about the agent.
//
// READ-ONLY BY CONSTRUCTION. It loads instructions, builds catalogs and
// validates. It executes no step, sends no turn, calls no model and writes
// nothing. Running it against production tells you which agents are safe to
// enable before any of them runs, rather than after.

import { getPoolForService } from '../infrastructure/database';
import { scrubLogger } from '../observability/scrub-logger';
import { validateWorkflowGraph, type WorkflowInputContract } from '../agent-execution/validate-workflow-graph';
import { resolveTriggerBoundTool } from '../agent-execution/resolve-trigger-bound-tool';
import { sandboxCapabilitiesForTier } from '../agent-execution/service';
import type { WorkflowStep } from '../agent-execution/types';
import type { CompiledInstruction } from '../instruction-compiler/types';

export interface AgentWorkflowVerdict {
  agentId: string;
  role: string | null;
  stepCount: number;
  /** Empty when the workflow would run. */
  problems: Array<{ code: string; stepId: string; message: string }>;
  /** False when the catalog could not be built, so tool names went unchecked
   *  and this verdict is structural only. Stated rather than implied: a clean
   *  verdict that skipped half its checks is not a clean verdict. */
  toolCatalogChecked: boolean;
}

export interface WorkflowStepsAuditResult {
  agentsWithSteps: number;
  wouldRun: number;
  wouldFail: number;
  /** Agents whose tool names could not be checked. Counted separately so a
   *  degraded run cannot be read as a passing one. */
  structuralOnly: number;
  verdicts: AgentWorkflowVerdict[];
}

interface AgentRow {
  id: string;
  role: string | null;
  tenant_id: string;
  workflow_steps: unknown;
  trigger_config: unknown;
}

function asSteps(raw: unknown): WorkflowStep[] | null {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? (parsed as WorkflowStep[]) : null;
}

/** What `input` will carry for this agent, derived from its stored trigger and
 *  its bound connectors.
 *
 *  The trigger config records a TOPIC (`email.received`), not a connector, and
 *  the topic→source map is loaded at run time from the connector service's
 *  catalog, so it is not available to a static check. The agent's bindings are:
 *  an event-triggered agent fires on one of the connectors it is bound to, so
 *  they are the candidate sources, and a field absent from all of them cannot
 *  appear whichever one fires. */
function inputContractFor(
  rawTriggerConfig: unknown,
  boundConnectorTypes: string[],
): WorkflowInputContract {
  const parsed = typeof rawTriggerConfig === 'string'
    ? (JSON.parse(rawTriggerConfig) as Record<string, unknown>)
    : (rawTriggerConfig as Record<string, unknown> | null);
  if (!parsed || parsed.type !== 'event') {
    return { triggerType: parsed?.type === 'cron' ? 'cron' : 'manual' };
  }
  return { triggerType: 'event', eventSources: boundConnectorTypes };
}

/** Every trigger that can start this agent, primary first.
 *
 *  A companion cron is not a second agent — it runs the SAME step graph. So the
 *  graph has to satisfy every trigger's input contract, and checking only the
 *  primary one is checking the case that was designed rather than the cases
 *  that fire. `unread-support-sweep` is the worked example: a cron companion on
 *  an event-triggered agent whose steps read `{{input.message.threadId}}`, a
 *  field no cron fire carries. */
function triggerContractsFor(
  rawTriggerConfig: unknown,
  boundConnectorTypes: string[],
): Array<{ label: string; contract: WorkflowInputContract }> {
  const parsed = typeof rawTriggerConfig === 'string'
    ? (JSON.parse(rawTriggerConfig) as Record<string, unknown>)
    : (rawTriggerConfig as Record<string, unknown> | null);

  const primaryLabel = typeof parsed?.type === 'string' ? parsed.type : 'manual';
  const contracts: Array<{ label: string; contract: WorkflowInputContract }> = [
    { label: primaryLabel, contract: inputContractFor(rawTriggerConfig, boundConnectorTypes) },
  ];

  const companions = Array.isArray(parsed?.companionCrons) ? parsed.companionCrons : [];
  for (const c of companions) {
    const comp = (c ?? {}) as { label?: unknown; workSource?: { source?: unknown } };
    const label = typeof comp.label === 'string' ? comp.label : 'companion';
    // A routine that declares a workSource RESOLVES its items and runs the
    // graph once per item with a synthesized `input.message` — the same
    // envelope the event path builds. Its contract is therefore the event
    // contract, not the bare cron one, and holding it to "a cron carries no
    // input" would fail a workflow that now runs correctly.
    const src = comp.workSource?.source;
    contracts.push(typeof src === 'string' && src.length > 0
      ? { label: `companion:${label}`, contract: { triggerType: 'event', eventSources: [src] } }
      : { label: `companion:${label}`, contract: { triggerType: 'cron' } });
  }
  return contracts;
}

/** Steps whose declared output the runtime cannot produce.
 *
 *  `wouldRun` used to mean "the graph parses and its tool names resolve". That
 *  can report every agent clean while every one of them fails, because what
 *  breaks them need not be structural: an
 *  `llm_reason` step declaring `outputField` had no way to return an object at
 *  all, so it threw on every run. A pre-flight that cannot see the contract a
 *  step must satisfy is not answering the question it is asked.
 *
 *  Now that `record_step_output` exists the contract is satisfiable, and what
 *  remains checkable here is the shape of the declaration itself: an
 *  `outputField` the tool schema cannot express. The tool asks for the path's
 *  ROOT segment, so an empty or whitespace-only field has no key to record
 *  under and the step could never satisfy it. */
function outputContractProblems(steps: WorkflowStep[]): Array<{ code: string; stepId: string; message: string }> {
  const problems: Array<{ code: string; stepId: string; message: string }> = [];
  for (const step of steps) {
    if (step.outputField === undefined) continue;
    const root = step.outputField.split('.')[0]?.trim();
    if (!root) {
      problems.push({
        code: 'UNSATISFIABLE_OUTPUT_FIELD',
        stepId: step.stepId,
        message:
          `step declares outputField "${step.outputField}", whose first path segment is empty — `
          + 'there is no key the step could record its result under, so the step can never satisfy it.',
      });
      continue;
    }
    if (step.type === 'delay') {
      problems.push({
        code: 'UNSATISFIABLE_OUTPUT_FIELD',
        stepId: step.stepId,
        message:
          'a delay step produces no value, so its outputField can never be satisfied and every '
          + 'downstream reference to it resolves to nothing.',
      });
    }
  }
  return problems;
}

export async function auditWorkflowSteps(): Promise<WorkflowStepsAuditResult> {
  const pool = getPoolForService('scheduled-execution');
  const { agentExecutionService } = await import('../agent-execution/service');

  const rows = await pool.query<AgentRow>(
    `SELECT id, role, tenant_id, workflow_steps, trigger_config
       FROM agents
      WHERE workflow_steps IS NOT NULL
        AND lifecycle <> 'DELETED'`,
  );

  const verdicts: AgentWorkflowVerdict[] = [];

  for (const row of rows.rows) {
    const steps = asSteps(row.workflow_steps);
    if (!steps || steps.length === 0) continue;

    // The agent's live tool catalog. Built through the same method the chat
    // path uses, so the names it yields are the names an execution would see.
    // A failure here is reported, never swallowed into a clean verdict.
    let toolNames: Set<string> | undefined;
    // The connector TYPES this agent is bound to, which are the candidate
    // sources for its `input`. Collected from the same instruction row the
    // catalog is built from so the two cannot describe different agents.
    let boundConnectorTypes: string[] = [];
    try {
      // `integrations` is a COLUMN on compiled_instructions, not a field inside
      // the `instruction` JSON — getActiveInstruction selects it alongside
      // `instruction`, and `instruction->'integrations'` is null.
      //
      // Reading the wrong one is not a quiet mistake here: it yields an empty
      // binding list, so buildChatToolCatalog returns a catalog with no
      // connector tools and EVERY connector step is reported UNRESOLVABLE_TOOL.
      // Every such finding is then entirely an artifact of this line.
      const instruction = await pool.query<{
        version: number;
        instruction: unknown;
        integrations: unknown;
        capability_tier: string | null;
      }>(
        `SELECT version, instruction, integrations, capability_tier FROM compiled_instructions
          WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'
          ORDER BY version DESC LIMIT 1`,
        [row.id, row.tenant_id],
      );
      if (instruction.rows.length > 0) {
        const rawIntegrations = instruction.rows[0].integrations;
        const parsed = typeof rawIntegrations === 'string'
          ? JSON.parse(rawIntegrations)
          : rawIntegrations;
        const integrations = Array.isArray(parsed)
          ? (parsed as Array<{ id: string; type?: string }>)
          : [];
        boundConnectorTypes = integrations
          .map((i) => i.type)
          .filter((t): t is string => typeof t === 'string' && t.length > 0);
        // An agent with bindings whose catalog came back empty means the
        // catalog build failed, not that the agent has no tools. Reporting a
        // tool verdict from that would repeat the mistake above in a subtler
        // form, so the verdict is marked structural-only instead.
        if (integrations.length === 0) {
          scrubLogger.warn({
            event: 'workflow_steps_audit_catalog_failed',
            agentId: row.id,
            problem: 'no bound integrations on the active compiled instruction',
            message: 'tool names unchecked — agent has no connector bindings',
          });
        }
        // The SAME function the run validates against, not merely a similar
        // one. This used to call `buildChatToolCatalog`, which returns
        // `gatewayResult.modelTools` — the in-process list, complete before
        // vendor servers are contacted and never updated after. So the audit
        // fetched GitHub's tools and then read an array that could not hold
        // them, and reported code-review agents as unable to run when the
        // engine resolves their steps fine.
        //
        // Chat's catalog answers a different question: what does the model get
        // offered. Validation asks what the dispatcher can execute. They are
        // allowed to differ (platform callbacks like `find_teammates` live in
        // the in-process server and are exempted by name in the validator);
        // what is not allowed is a pre-flight check answering from the other
        // one.
        // `compiled_instructions.instruction` can be NULL, so this coalesces
        // rather than trusting the column. The chat
        // catalog never read it — it takes allowedActionTypes and integrations
        // directly — so the null was invisible until validation started building
        // its catalog from the same seam a run does.
        //
        // `{}` is not a degradation: buildToolsSchema reads exactly two fields
        // off this object and already defaults both to `['*']`, which is the
        // wildcard the previous `allowedActionTypes: ['*']` argument passed
        // explicitly. Passing null instead throws on `.allowedConnectors`, and
        // the catch turns that into `toolCatalogChecked: false` for every agent
        // — a full audit that silently checks no tool names at all.
        const rawInstruction = instruction.rows[0].instruction;
        const parsedInstruction = typeof rawInstruction === 'string'
          ? JSON.parse(rawInstruction)
          : rawInstruction;
        toolNames = await agentExecutionService.buildValidationToolNames({
          tenantId: row.tenant_id,
          agentId: row.id,
          instruction: (parsedInstruction ?? {}) as CompiledInstruction,
          integrations,
          // Derived exactly as a run derives it, from the compiled
          // instruction's capability tier. Without it the catalog carries no
          // sandbox tools at all, so every step naming one — `shell_exec`,
          // `file_*`, `browser_*` — was reported UNRESOLVABLE_TOOL for a tool
          // the agent genuinely holds.
          sandboxCapabilities: sandboxCapabilitiesForTier(
            (instruction.rows[0].capability_tier as 'connector_only' | 'execution_enabled' | null) ?? undefined,
          ),
          // No threadId on purpose: it exists to look up an ACTIVE browser
          // session, and this job has no thread. Passing a synthetic one buys a
          // guaranteed-empty query per agent.
        });
      }
    } catch (err) {
      scrubLogger.warn({
        event: 'workflow_steps_audit_catalog_failed',
        agentId: row.id,
        problem: (err as Error).message,
        message: 'tool catalog unavailable — verdict is structural only',
      });
    }

    // Resolve trigger-bound steps the way a RUN does, before validating.
    //
    // A step may name `trigger__<op>` — the operation, not the host — and the
    // executor rewrites it to whichever connector fired before it validates.
    // This job did not, so it validated a name no catalog contains and reported
    // UNRESOLVABLE_TOOL for a step that runs correctly. A pre-flight that cries
    // wolf is worth as little as one that reports clean wrongly: both teach the
    // reader to skip it, which is how this workflow shipped in the first place.
    //
    // The run knows its one triggering host; this job knows only the connectors
    // the agent is bound to, so a step resolves here if ANY of them provides the
    // operation — the same union reading the input-field check uses, and for the
    // same reason.
    const auditSteps = toolNames
      ? steps.map((step) => {
        if (!step.toolName) return step;
        for (const source of boundConnectorTypes.length > 0 ? boundConnectorTypes : [undefined]) {
          const bound = resolveTriggerBoundTool(step.toolName, source, toolNames);
          if (bound.kind === 'not_applicable') return step;
          if (bound.kind === 'resolved') return { ...step, toolName: bound.toolName };
          // Name resolved, addressing unjudgeable. That is the ONLY answer this
          // job can ever get for a trigger-bound step: identity arguments are
          // built from the record the event carried, and a pre-flight check has
          // no event. Treated as resolved here, because the question the audit
          // asks — would the validator find this tool — is answered.
          //
          // Reported as UNRESOLVABLE_TOOL until now, for every trigger-bound
          // step in the fleet, permanently, for a reason that says nothing about
          // the workflow. The test that was meant to catch this asserted
          // `resolved === raw || catalog.has(resolved)`, which is true either
          // way and so proved nothing.
          if (bound.kind === 'resolvable') return { ...step, toolName: bound.toolName };
          // A skip means the step will not run at all, so its name is not a
          // claim about anything and must not be judged as one.
          if (bound.kind === 'skip') return { ...step, __triggerBoundSkip: bound.reason };
        }
        // Every candidate host failed to resolve it. Left as written so the
        // validator reports it — this is a real finding, not a false one.
        return step;
      })
      : steps;

    // Validated against EVERY trigger that can start this agent, not just the
    // primary one.
    //
    // A companion cron runs the SAME step graph as the primary trigger, and it
    // is a different contract: a cron fire carries no `input`. Checking only
    // the primary trigger lets a support agent pass whose graph reads
    // `{{input.message.threadId}}` — correct for the `event` trigger it was
    // written for, and unsatisfiable for the companion crons that also run it.
    // Every companion fire fails step 1, takes the escalation branch, and marks
    // mail read without opening the mailbox, while the audit reports the agent
    // runnable.
    //
    // Companion crons are common, so this is a fleet-wide blind spot rather than
    // one agent's.
    const contracts = triggerContractsFor(row.trigger_config, boundConnectorTypes);
    const problems = contracts.flatMap(({ label, contract }) => {
      const found = validateWorkflowGraph(auditSteps, toolNames, contract);
      // Only the input-contract findings are per-trigger; everything else
      // (structure, tool names, dispatchability) is identical across triggers
      // and would otherwise be reported once per trigger.
      return contracts.length === 1
        ? found
        : found
          .filter((p) => label === contracts[0].label || p.code === 'UNKNOWN_INPUT_FIELD')
          .map((p) => (label === contracts[0].label
            ? p
            : { ...p, message: `[trigger: ${label}] ${p.message}` }));
    });
    verdicts.push({
      agentId: row.id,
      role: row.role,
      stepCount: steps.length,
      problems: [
        ...problems.map((p) => ({ code: p.code, stepId: p.stepId ?? '', message: p.message })),
        // The output contract, checked alongside the graph so `wouldRun` means
        // "every step can produce what it declares", not only "the graph parses".
        ...outputContractProblems(steps),
      ],
      toolCatalogChecked: toolNames !== undefined && toolNames.size > 0,
    });
  }

  const result: WorkflowStepsAuditResult = {
    agentsWithSteps: verdicts.length,
    wouldRun: verdicts.filter((v) => v.problems.length === 0).length,
    wouldFail: verdicts.filter((v) => v.problems.length > 0).length,
    structuralOnly: verdicts.filter((v) => !v.toolCatalogChecked).length,
    verdicts,
  };

  // Every verdict structural-only is a failure of this JOB, not a clean fleet,
  // and it is the one outcome that reads like good news: `wouldFail: 0` with
  // every tool name unchecked. It has happened — a null `instruction` column
  // threw inside the catalog build for all six agents, each one caught and
  // downgraded individually, and the summary said zero failures. Said out loud
  // here so the answer is not carried only by a counter the reader has to know
  // to look at.
  if (result.agentsWithSteps > 0 && result.structuralOnly === result.agentsWithSteps) {
    scrubLogger.warn({
      event: 'workflow_steps_audit_degraded',
      agentsWithSteps: result.agentsWithSteps,
      message:
        'NO tool names were checked for ANY agent — every catalog build failed. '
        + 'wouldRun/wouldFail describe structure only and say nothing about tools.',
    });
  }

  scrubLogger.info({
    event: 'workflow_steps_audit',
    agentsWithSteps: result.agentsWithSteps,
    wouldRun: result.wouldRun,
    wouldFail: result.wouldFail,
    structuralOnly: result.structuralOnly,
    message: 'workflow steps audit complete',
  });

  for (const v of result.verdicts.filter((x) => x.problems.length > 0)) {
    scrubLogger.warn({
      event: 'workflow_steps_audit_finding',
      agentId: v.agentId,
      codes: v.problems.map((p) => p.code).join(','),
      stepCount: v.stepCount,
      toolCatalogChecked: v.toolCatalogChecked,
      message: 'agent workflow would not run as stored',
    });
  }

  return result;
}
