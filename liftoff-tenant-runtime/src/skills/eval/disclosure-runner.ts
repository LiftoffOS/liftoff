// Runs the disclosure golden set both ways against a real deployed agent and
// reports what the second way costs.
//
// The measurement is a paired comparison: the same task, the same agent, the
// same skills, the same deployment, differing only in whether the guidance was
// in the prompt or behind `read_skill`. Anything that varies between the arms
// other than the mode is a confound, which is why the mode is a per-request
// override rather than an environment flip — an env flip means two deployments,
// two model routings and two moments in time, and a difference measured across
// those says nothing about disclosure.
//
// WHAT IT REPORTS, AND WHY EACH NUMBER IS SEPARATE.
//
//   inline pass rate      The control. If this is not near 1.0 the SET is
//                         broken, not the mode: the guidance was in the prompt
//                         in full and still did not reach the answer.
//   disclosed pass rate   The measurement.
//   read rate             How often the agent chose to call read_skill when it
//                         had the option. This is the mechanism behind any gap:
//                         a disclosed failure with no read is the model deciding
//                         it did not need the guidance, which is the specific
//                         risk disclosure introduces.
//   read-then-fail        Read the skill and still got it wrong. A different
//                         defect entirely — that is a prompt or a comprehension
//                         problem, not a disclosure problem, and no amount of
//                         nudging the model to read more will fix it.
//   tokens                What the mode was supposed to buy. Reported per arm so
//                         the saving can be weighed against whatever the pass
//                         rate did, rather than assumed.
//
// The run is READ-MOSTLY on production data: it seeds ten skills onto ONE
// designated eval agent and sends it turns. It never touches another agent, and
// it upserts by fixed id so repeated runs update rather than accumulate.

import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import { getPoolForService } from '../../infrastructure/database';
import { generateEmbeddingDetailed } from '../../memory/embedding';
import { scrubLogger } from '../../observability/scrub-logger';
import {
  DISCLOSURE_EVAL_TASKS,
  evalSkills,
  gradeAnswer,
  type DisclosureEvalTask,
  type TaskVerdict,
} from './disclosure-tasks';
import type { SkillDisclosureMode } from '../retrieval';

const MODES: readonly SkillDisclosureMode[] = ['inline', 'disclosed'];

export interface DisclosureRunConfig {
  /** Tenant the eval agent lives in. */
  tenantId: string;
  /** INTERNAL agent id — the harness route maps it to the runtime id itself,
   *  the same way the real chat handler does. Passing a runtime id here matches
   *  zero rows and fails with no error — the id-space trap. */
  internalAgentId: string;
  /** Runtime agent id — what `agent_skills.agent_id` holds, so seeding needs it.
   *  Resolved from the mapping when not supplied. */
  runtimeAgentId?: string;
  /** Deployed run-agent harness endpoint. */
  harnessUrl: string;
  /** Bounds the loop per task. Small: these tasks need at most one read_skill
   *  and an answer, and a larger bound only buys a runaway more room. */
  maxTurns: number;
}

export interface TaskArmResult {
  taskId: string;
  mode: SkillDisclosureMode;
  verdict: TaskVerdict;
  /** Did the agent call read_skill, and for the right skill? An id from another
   *  task's skill is a retrieval problem wearing a disclosure problem's clothes. */
  readSkillCalls: number;
  readItsOwnSkill: boolean;
  /** Was read_skill even in the catalog? If not, the disclosed arm did not run —
   *  it silently ran inline, and reporting a pass would be a lie. */
  readSkillExposed: boolean;
  /** Did retrieval actually put THIS task's skill in front of the model?
   *
   *  If not, nothing about disclosure was measured: the guidance was never
   *  offered in either arm, so a failure says the embedding missed, not that the
   *  model declined to read. Kept separate from every other outcome because
   *  "the model ignored it" and "it was never there" are opposite findings that
   *  a pass/fail column cannot distinguish. */
  taskSkillRetrieved: boolean;
  inputTokens: number;
  outputTokens: number;
  answer: string;
  error?: string;
}

export interface DisclosureRunReport {
  ranAt: string;
  config: Omit<DisclosureRunConfig, 'harnessUrl'>;
  results: TaskArmResult[];
  summary: {
    inlinePassRate: number;
    /** null when every task's inline arm failed, so nothing was measurable.
     *  Reporting 0 there would read as a total disclosure failure when the
     *  truth is that the eval set did not run — the two are opposite findings
     *  and must not share a value. */
    disclosedPassRate: number | null;
    /** Of the disclosed arms, how many called read_skill. */
    readRate: number;
    /** Disclosed failures where the agent never read the skill. The gap. */
    failedWithoutReading: string[];
    /** Disclosed failures where it DID read. A different defect. */
    failedAfterReading: string[];
    /** Tasks whose inline arm failed — broken tasks, and their disclosed result
     *  must not be counted as evidence about the mode. */
    brokenTasks: string[];
    /** Tasks whose own skill retrieval never surfaced. Excluded from BOTH rates:
     *  the guidance was not in front of the model in either arm, so neither arm
     *  says anything about disclosure. Reported first, because a task here is
     *  also the reason its inline arm failed, and reading it as a broken task
     *  sends you to rewrite a task when the embedding is what missed. */
    skillNeverRetrieved: string[];
    inlineTokens: number;
    disclosedTokens: number;
  };
}

// ── the deployed harness ─────────────────────────────────────────────────────

const auth = new GoogleAuth();
let idClient: IdTokenClient | null = null;

async function harnessHeaders(url: string): Promise<Record<string, string>> {
  const audience = new URL(url).origin;
  if (!idClient) idClient = await auth.getIdTokenClient(audience);
  const headers = await idClient.getRequestHeaders();
  const out: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') out[k] = v;
  return out;
}

interface HarnessResponse {
  ok: boolean;
  finalText: string;
  toolCalls: Array<{ toolName: string; args: unknown }>;
  exposedToolNames: string[];
  retrievedSkillIds?: string[];
  inputTokens: number;
  outputTokens: number;
  outcome: string | null;
  error?: string;
}

async function runOne(
  cfg: DisclosureRunConfig,
  task: DisclosureEvalTask,
  mode: SkillDisclosureMode,
): Promise<TaskArmResult> {
  const base: Omit<TaskArmResult, 'verdict'> & { verdict?: TaskVerdict } = {
    taskId: task.id,
    mode,
    readSkillCalls: 0,
    readItsOwnSkill: false,
    readSkillExposed: false,
    taskSkillRetrieved: false,
    inputTokens: 0,
    outputTokens: 0,
    answer: '',
  };

  let res: Response;
  try {
    res = await fetch(cfg.harnessUrl, {
      method: 'POST',
      headers: await harnessHeaders(cfg.harnessUrl),
      body: JSON.stringify({
        tenantId: cfg.tenantId,
        agentId: cfg.internalAgentId,
        prompt: task.prompt,
        maxTurns: cfg.maxTurns,
        skillDisclosureMode: mode,
      }),
    });
  } catch (err) {
    return { ...base, verdict: gradeAnswer(task, ''), error: `harness unreachable: ${(err as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ...base, verdict: gradeAnswer(task, ''), error: `harness ${res.status}: ${body.slice(0, 300)}` };
  }

  const data = (await res.json()) as HarnessResponse;
  const reads = data.toolCalls.filter((c) => c.toolName === 'read_skill');

  return {
    ...base,
    verdict: gradeAnswer(task, data.finalText ?? ''),
    readSkillCalls: reads.length,
    readItsOwnSkill: reads.some(
      (c) => (c.args as { id?: string } | null)?.id === task.skill.id,
    ),
    readSkillExposed: (data.exposedToolNames ?? []).includes('read_skill'),
    taskSkillRetrieved: (data.retrievedSkillIds ?? []).includes(task.skill.id),
    inputTokens: data.inputTokens ?? 0,
    outputTokens: data.outputTokens ?? 0,
    answer: data.finalText ?? '',
    error: data.ok ? undefined : (data.error ?? `outcome=${data.outcome}`),
  };
}

// ── seeding ──────────────────────────────────────────────────────────────────

/** Put the eval skills on the eval agent, by fixed id.
 *
 *  Embeddings are generated against the DESCRIPTION, matching how the real
 *  skill writer does it — the description is the semantic anchor retrieval
 *  scores on. Seeding against the instruction instead would make these skills
 *  retrieve differently from every real one, and the eval would be measuring an
 *  artefact of its own seeding. */
export async function seedEvalSkills(tenantId: string, runtimeAgentId: string): Promise<number> {
  const pool = getPoolForService('scheduled-execution');
  let written = 0;

  for (const skill of evalSkills()) {
    // Detailed shape, because the row records which model produced the vector.
    // The legacy shape would leave `embedding_model` to a guess, and a wrong
    // model recorded next to a vector is how a later re-embed silently mixes
    // dimensions.
    const { embedding, model } = await generateEmbeddingDetailed(skill.description, {
      tenantId,
      agentId: runtimeAgentId,
      purpose: 'embedding_retrieval',
      taskType: 'retrieval_document',
    });
    const r = await pool.query(
      `INSERT INTO agent_skills
         (id, tenant_id, agent_id, name, description, instruction, embedding,
          embedding_model, tags, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::vector, $8, $9, 'active')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         instruction = EXCLUDED.instruction,
         embedding = EXCLUDED.embedding,
         embedding_model = EXCLUDED.embedding_model,
         tags = EXCLUDED.tags,
         status = 'active',
         updated_at = NOW()`,
      [
        skill.id, tenantId, runtimeAgentId, skill.name, skill.description,
        skill.instruction, `[${embedding.join(',')}]`, model, skill.tags,
      ],
    );
    // rowCount, not the loop counter: a tally of calls reports ten writes when
    // ten statements silently wrote nothing.
    written += r.rowCount ?? 0;
  }
  return written;
}

/** The runtime agent id for an internal agent id. They are disjoint spaces and a
 *  wrong-space id matches zero rows with no error, so this resolves rather than
 *  assumes. */
async function resolveRuntimeAgentId(tenantId: string, internalAgentId: string): Promise<string> {
  const pool = getPoolForService('scheduled-execution');
  const r = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM internal_agent_runtime_mapping
      WHERE internal_agent_id = $1::uuid AND tenant_id = $2::uuid`,
    [internalAgentId, tenantId],
  );
  if (r.rows.length === 0) {
    throw new Error(
      `no runtime agent mapped to internal agent ${internalAgentId} in tenant ${tenantId} — `
      + 'check the id is an internal_agents.id and not a runtime agents.id',
    );
  }
  return r.rows[0].agent_id;
}

// ── the run ──────────────────────────────────────────────────────────────────

export async function runDisclosureEval(cfg: DisclosureRunConfig): Promise<DisclosureRunReport> {
  const runtimeAgentId = cfg.runtimeAgentId
    ?? (await resolveRuntimeAgentId(cfg.tenantId, cfg.internalAgentId));

  const seeded = await seedEvalSkills(cfg.tenantId, runtimeAgentId);
  scrubLogger.info({
    event: 'skill_disclosure_eval_seeded',
    skills: seeded,
    tasks: DISCLOSURE_EVAL_TASKS.length,
    message: 'seeded disclosure eval skills',
  });

  const results: TaskArmResult[] = [];
  // Sequential, not parallel. Ten tasks times two arms against one agent, and
  // the agent lock is bypassed for harness runs — firing them concurrently would
  // put twenty turns through one agent at once, which measures contention.
  for (const task of DISCLOSURE_EVAL_TASKS) {
    for (const mode of MODES) {
      results.push(await runOne(cfg, task, mode));
    }
  }

  const arm = (m: SkillDisclosureMode): TaskArmResult[] => results.filter((r) => r.mode === m);
  const rate = (rs: TaskArmResult[]): number =>
    rs.length === 0 ? 0 : rs.filter((r) => r.verdict.pass).length / rs.length;

  const inline = arm('inline');
  const disclosed = arm('disclosed');

  // Retrieval first. A task whose skill never surfaced was never asked the
  // question, so it is neither a broken task nor evidence about the mode, and
  // classifying it as either would send somebody to fix the wrong thing.
  const skillNeverRetrieved = inline
    .filter((r) => !r.taskSkillRetrieved && !r.error)
    .map((r) => r.taskId);
  const measurableInline = inline.filter((r) => !skillNeverRetrieved.includes(r.taskId));
  const brokenTasks = measurableInline.filter((r) => !r.verdict.pass).map((r) => r.taskId);
  // Broken tasks are excluded from the disclosed reading, not just annotated:
  // a task whose guidance did not land even when handed over in full cannot say
  // anything about what happens when it is not.
  const disclosedMeasurable = disclosed.filter(
    (r) => !brokenTasks.includes(r.taskId) && !skillNeverRetrieved.includes(r.taskId),
  );
  const disclosedFailures = disclosedMeasurable.filter((r) => !r.verdict.pass);

  const report: DisclosureRunReport = {
    ranAt: new Date().toISOString(),
    config: {
      tenantId: cfg.tenantId,
      internalAgentId: cfg.internalAgentId,
      runtimeAgentId,
      maxTurns: cfg.maxTurns,
    },
    results,
    summary: {
      inlinePassRate: rate(measurableInline),
      disclosedPassRate: disclosedMeasurable.length === 0 ? null : rate(disclosedMeasurable),
      readRate:
        disclosed.length === 0
          ? 0
          : disclosed.filter((r) => r.readSkillCalls > 0).length / disclosed.length,
      failedWithoutReading: disclosedFailures.filter((r) => r.readSkillCalls === 0).map((r) => r.taskId),
      failedAfterReading: disclosedFailures.filter((r) => r.readSkillCalls > 0).map((r) => r.taskId),
      brokenTasks,
      skillNeverRetrieved,
      inlineTokens: inline.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0),
      disclosedTokens: disclosed.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0),
    },
  };

  scrubLogger.info({
    event: 'skill_disclosure_eval',
    inlinePassRate: report.summary.inlinePassRate,
    // -1 rather than null: the log schema takes a number, and a sentinel that
    // cannot be a rate is unambiguous where a 0 would not be.
    disclosedPassRate: report.summary.disclosedPassRate ?? -1,
    readRate: report.summary.readRate,
    brokenTasks: report.summary.brokenTasks.length,
    skillNeverRetrieved: report.summary.skillNeverRetrieved.length,
    failedWithoutReading: report.summary.failedWithoutReading.length,
    failedAfterReading: report.summary.failedAfterReading.length,
    inlineTokens: report.summary.inlineTokens,
    disclosedTokens: report.summary.disclosedTokens,
    message: 'skill disclosure eval complete',
  });

  return report;
}

/** Markdown, because the output is read by a person deciding whether to flip a
 *  default, and a JSON blob is not that. */
export function renderReport(report: DisclosureRunReport): string {
  const s = report.summary;
  const pct = (n: number | null): string =>
    n === null ? 'not measurable' : `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [
    `# Skill disclosure eval — ${report.ranAt}`,
    '',
    `Agent \`${report.config.internalAgentId}\` in tenant \`${report.config.tenantId}\`.`,
    '',
    '| | inline | disclosed |',
    '|---|---|---|',
    `| pass rate | ${pct(s.inlinePassRate)} | ${pct(s.disclosedPassRate)} |`,
    `| tokens | ${s.inlineTokens.toLocaleString()} | ${s.disclosedTokens.toLocaleString()} |`,
    '',
    `read_skill called on ${pct(s.readRate)} of disclosed arms.`,
    '',
  ];

  if (s.skillNeverRetrieved.length > 0) {
    lines.push(
      '## Skill never retrieved — nothing was measured',
      '',
      'Retrieval did not put these tasks\' own guidance in front of the model, in',
      'either arm. That is an embedding problem, not a disclosure result, and it is',
      'also why their inline arm failed. Fix retrieval before rewriting the task.',
      '',
      ...s.skillNeverRetrieved.map((t) => `- ${t}`),
      '',
    );
  }
  if (s.brokenTasks.length > 0) {
    lines.push(
      '## Broken tasks — excluded from the disclosed rate',
      '',
      'These failed with the guidance in the prompt IN FULL. That is a defect in',
      'the task, not evidence about disclosure, and their disclosed results are',
      'not counted above.',
      '',
      ...s.brokenTasks.map((t) => `- ${t}`),
      '',
    );
  }
  if (s.failedWithoutReading.length > 0) {
    lines.push(
      '## Failed without reading — the cost of disclosure',
      '',
      'The guidance was listed, the tool was there, the agent did not use it.',
      '',
      ...s.failedWithoutReading.map((t) => `- ${t}`),
      '',
    );
  }
  if (s.failedAfterReading.length > 0) {
    lines.push(
      '## Failed after reading — not a disclosure problem',
      '',
      'The agent fetched the guidance and still got it wrong. Nudging it to read',
      'more will not fix these.',
      '',
      ...s.failedAfterReading.map((t) => `- ${t}`),
      '',
    );
  }

  lines.push('## Every arm', '', '| task | mode | pass | read | detail |', '|---|---|---|---|---|');
  for (const r of report.results) {
    const detail = r.error
      ? `error: ${r.error}`
      : [
        r.verdict.missingEvidence.length ? `missing ${r.verdict.missingEvidence.join(', ')}` : '',
        r.verdict.forbidden.length ? `said ${r.verdict.forbidden.join(', ')}` : '',
        r.verdict.notSubstantive.length ? 'no substantive answer' : '',
        // A disclosed arm with no read_skill in the catalog did not run in
        // disclosed mode at all, whatever it scored.
        r.mode === 'disclosed' && !r.readSkillExposed ? 'READ_SKILL NOT EXPOSED' : '',
        !r.taskSkillRetrieved ? 'SKILL NOT RETRIEVED' : '',
      ].filter(Boolean).join('; ');
    lines.push(
      `| ${r.taskId} | ${r.mode} | ${r.verdict.pass ? 'yes' : 'no'} `
      + `| ${r.readSkillCalls > 0 ? (r.readItsOwnSkill ? 'own' : 'other') : '-'} | ${detail || 'ok'} |`,
    );
  }
  return lines.join('\n');
}
