// template-eval-harness — run a template's eval cases against a hired agent.
//
// Patterned on distill-ab-harness.ts beside it, and dev-only for the same
// reason: every case is a real agent run against real connectors, so this
// SPENDS REAL MONEY and can write to whatever the agent is bound to. It refuses
// to run anywhere but dev.
//
// RECORD THEN REPLAY. A live run is expensive and non-deterministic; the
// CHECKING of it is neither. So a run records what the agent did, and the
// checker can be re-run against that recording for free, as many times as the
// expectations are edited. That split matters more here than it looks: an eval
// suite people cannot re-check without paying is one they stop re-checking, and
// the expectations then drift away from what the cases were about.
//
//   npx ts-node src/scripts/template-eval-harness.ts --template code-reviewer \
//     --tenant <uuid> --agent <uuid> --record
//   (TENANT_RUNTIME_SERVICE_TOKEN in the environment; PB_BASE_URL defaults to dev)
//   npx ts-node src/scripts/template-eval-harness.ts --template code-reviewer --replay
//
// `--provider <family>` runs the same cases on another vendor family than the
// hire is configured for (the runtime's service-auth-only override, triggered
// cases only) and keeps those recordings apart, under
// `.eval-recordings/<template>/<provider>/`. The same hire recorded on every
// family is how a default engine is proven on the path it will own.
//
// TWO AUTHORING RULES, restated here because this is where they get broken:
//
//   EVERY POSITIVE HAS A NEGATIVE. A case asserting an agent escalates a risky
//   change passes trivially for an agent that escalates everything. The
//   validator enforces the pairing; this harness reports the pair together so a
//   half-passing pair cannot read as a pass.
//
//   WHEN A LIVE RUN TAKES AN UNEXPECTED ROUTE AND THE ANSWER WAS RIGHT, WIDEN
//   THE ACCEPTABLE SET — never re-pin to the observed route. Re-pinning turns
//   the case into a record of what the model happened to do on the day it was
//   written, and every later improvement then reads as a regression. That is
//   why `expected` holds only the keys a case is ABOUT, and why the report
//   prints the observed route next to a failure rather than offering to adopt
//   it.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { llmClient } from '../llm';
import { LLMRefusalError } from '../llm/types';
import { log } from '../infrastructure/logging';
import { getTemplate, initTemplateLoader } from '../agent-templates/loader';
import { matchBareName } from '@liftoffos/agent-test-scenarios';
import type { AgentHarnessRunResult } from '@liftoffos/agent-test-scenarios';
import type { AgentTemplate } from '../agent-templates/schema';

type TemplateEval = NonNullable<AgentTemplate['evals']>[number];
type Expectation = TemplateEval['expected'];

const RECORDINGS = join(__dirname, '..', '..', '.eval-recordings');

/** One delivery of a case. A chat case has exactly one; a trigger case has one
 *  per turn, because each turn IS a delivery of the event. */
export interface DeliveryRecording {
  toolNames: string[];
  toolArgs: Array<{ toolName: string; args: unknown }>;
  finalText: string;
  outcome: string | null;
  /** The runtime invocation, so the recording can be traced to its logs —
   *  which engine ran it, what the gate decided — rather than argued about. */
  invocationId?: string;
}

/** What one case's live run produced, in the form the checker reads. */
export interface CaseRecording {
  caseId: string;
  templateId: string;
  recordedAt: string;
  finalText: string;
  toolNames: string[];
  /** What each call was made WITH.
   *
   *  A role whose output is a posted artifact says nothing about it in its
   *  reply: the code reviewer's escalation lives in the review body it sends
   *  to GitHub, while `finalText` is a summary written for whoever asked. A
   *  case asserting on the reply therefore reads the wrong artifact — and
   *  passed or failed on paraphrase. The arguments are what the agent actually
   *  wrote, so they are what an assertion about output should read. */
  toolArgs: Array<{ toolName: string; args: unknown }>;
  /** Skills the run loaded, for `no_skill_load`. A skill load shows up as a
   *  tool call in the trace, so this is derived rather than reported. */
  skillLoads: string[];
  outcome: string | null;
  error?: string;
  /** Per delivery, in order. Absent on a recording made before deliveries were
   *  split — the checker treats a missing list as one delivery holding
   *  everything, so an old recording still replays. */
  deliveries?: DeliveryRecording[];
  /** The vendor family the run was forced onto, when it was; absent means the
   *  hire's own. */
  provider?: string;
}

/** A deferred connector tool, called through its search wrapper.
 *
 *  On the engines that reach tools over the HTTP MCP proxy the connector's
 *  tools are deferred behind `search_<alias>_tools` and dispatched through
 *  `call_<alias>_tool` with `{ name, args }`, so the trace names the wrapper
 *  and the tool the agent actually used sits inside its arguments. The
 *  Anthropic engine's own tool search surfaces the tool by its real name. A
 *  case that names a tool must see the same call either way, so the wrapper
 *  is unwrapped at recording time and the wrapped name and arguments are what
 *  the checker reads. */
const CALL_WRAPPER = /^call_.+_tool$/;

export function effectiveToolCall(
  call: { toolName: string; args?: unknown },
): { toolName: string; args: unknown } {
  if (CALL_WRAPPER.test(call.toolName) && call.args && typeof call.args === 'object') {
    const inner = call.args as { name?: unknown; args?: unknown };
    if (typeof inner.name === 'string' && inner.name.length > 0) {
      return { toolName: inner.name, args: inner.args ?? null };
    }
  }
  return { toolName: call.toolName, args: call.args ?? null };
}

/**
 * Check one expectation against one recording.
 *
 * Pure, and separated from everything that costs money precisely so it can be
 * unit-tested and re-run. Returns the failures in the order the expectation
 * declares them, each naming what was expected AND what happened — a failure
 * that says only "expected create_review_comment" sends the reader back to the
 * recording to find out what the agent did instead.
 */
export function checkExpectation(
  expected: Expectation,
  rec: CaseRecording,
): string[] {
  const failures: string[] = [];
  const called = rec.toolNames;

  for (const tool of expected.calls_tool ?? []) {
    if (!called.some((n) => matchBareName(n, tool))) {
      failures.push(`expected a call to ${tool}; the run called ${called.join(', ') || 'nothing'}`);
    }
  }

  // `calls_any_of` is satisfied by ONE of the listed tools, where `calls_tool`
  // demands every one. Posting a review is the case in point: GitHub exposes
  // several honest routes to it — open a pending review and add comments to it,
  // or leave the summary as an issue comment — and a case that named one route
  // would fail an agent that took another and did the job. That is the
  // re-pinning this harness exists to avoid.
  const anyOf = expected.calls_any_of ?? [];
  if (anyOf.length > 0 && !anyOf.some((tool) => called.some((n) => matchBareName(n, tool)))) {
    failures.push(
      `expected a call to one of ${anyOf.join(' / ')}; the run called ${called.join(', ') || 'nothing'}`,
    );
  }

  // What the agent WROTE, wherever it wrote it. `reply_includes` reads the
  // summary it hands back; this reads the arguments it passed to a tool. For a
  // role whose whole output is a posted artifact, the second is the real one.
  const writes = JSON.stringify(rec.toolArgs ?? []);
  for (const text of expected.writes_include ?? []) {
    if (!writes.includes(text)) {
      failures.push(
        `expected "${text}" in the arguments of some tool call; the run wrote none containing it`,
      );
    }
  }
  // Any one phrasing of the message the role must convey. A case that pinned
  // one string read two engines saying the same thing in a different order as
  // two failures; the acceptable set is the meaning, said either way.
  const anyText = expected.writes_include_any ?? [];
  if (anyText.length > 0 && !anyText.some((text) => writes.includes(text))) {
    failures.push(
      `expected one of ${anyText.map((t) => `"${t}"`).join(' / ')} in the arguments of some tool call; the run wrote none containing any`,
    );
  }
  for (const text of expected.writes_omit ?? []) {
    if (writes.includes(text)) {
      failures.push(`expected NO tool call carrying "${text}"; one did`);
    }
  }

  for (const tool of expected.never_calls ?? []) {
    if (called.some((n) => matchBareName(n, tool))) {
      failures.push(`expected NO call to ${tool}; the run called it`);
    }
  }

  // What the agent did on the LAST delivery, which is the only place a
  // "do not do it again" can be asserted.
  //
  // `never_calls` cannot express it: a case that delivers an event twice and
  // expects one action has to permit the action once, and a rule that forbids
  // it outright forbids the first one too. Counting calls does not work either
  // — one GitHub review is four calls to `pull_request_review_write`
  // (create → delete_pending → create → submit_pending), so a threshold on the
  // name measures the vendor's step count rather than the agent's judgement.
  const lastDelivery = rec.deliveries?.[rec.deliveries.length - 1];
  const lastCalled = lastDelivery ? lastDelivery.toolNames : called;
  for (const tool of expected.last_delivery_never_calls ?? []) {
    if (lastCalled.some((n) => matchBareName(n, tool))) {
      failures.push(
        `expected NO call to ${tool} on the final delivery; the run called it again`,
      );
    }
  }

  if (expected.first_tool !== undefined) {
    const first = called[0];
    if (!first || !matchBareName(first, expected.first_tool)) {
      failures.push(`expected ${expected.first_tool} first; the run started with ${first ?? 'no tool call'}`);
    }
  }

  for (const phrase of expected.reply_includes ?? []) {
    if (!rec.finalText.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push(`expected the reply to include "${phrase}"; it did not`);
    }
  }

  for (const phrase of expected.reply_omits ?? []) {
    if (rec.finalText.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push(`expected the reply to omit "${phrase}"; it said it`);
    }
  }

  if (expected.no_skill_load === true && rec.skillLoads.length > 0) {
    failures.push(
      `expected no skill load; the run loaded ${rec.skillLoads.join(', ')}`,
    );
  }

  return failures;
}

/**
 * Grade a `rubric` expectation with a model.
 *
 * Last resort, and the report says so on every case that uses one. A rubric
 * costs a model call and returns a judgement rather than a fact, so a suite
 * that reaches for it by default has stopped being a regression test. The
 * deterministic keys above answer most of what a case is actually about.
 *
 * UNCALIBRATED, stated plainly: the calibrated judges the plan points at live
 * in the tenant runtime's diagnostics grader, which this repo cannot reach. So
 * this asks one narrow question with the answer constrained to a token, and a
 * malformed answer FAILS the case rather than passing it — a judge that cannot
 * be parsed knows nothing, and reading that as a pass is how a suite goes
 * quietly green.
 */
export async function gradeRubric(
  rubric: string,
  rec: CaseRecording,
  tenantId: string,
): Promise<string[]> {
  let response: Awaited<ReturnType<typeof llmClient.complete>>;
  try {
    response = await llmClient.complete({
      messages: [
        {
          role: 'system',
          content:
            'You judge whether one agent reply satisfies one stated criterion. '
            + 'Answer with exactly one word: PASS or FAIL. Judge only the criterion given. '
            + 'A reply that is good but does not meet the criterion is FAIL.',
        },
        {
          role: 'user',
          content: `Criterion:\n${rubric}\n\nThe agent's reply:\n${rec.finalText}`,
        },
      ],
      tier: 'medium',
      // The answer is constrained by the PARSE below, not by the budget. The
      // medium tier thinks before it answers when it decides to, and thinking
      // spends this budget before the first word of text — a budget sized to
      // the word alone returns an empty reply, which the parse reads as a
      // failed case on every rubric the model paused over. Sized for a long
      // reply judged against a long criterion.
      maxTokens: 4096,
      temperature: 0,
    }, undefined, { tenantId, purpose: 'template_eval_rubric' });
  } catch (err) {
    // A refusal is the judge declining THIS case, not the suite breaking: the
    // case fails, says why, and the cases after it are still graded. Anything
    // else — no provider, a network fault — is the suite breaking and stays
    // an error.
    if (err instanceof LLMRefusalError) {
      return [`rubric judge refused to grade this reply (${err.category ?? 'refusal'}) — treated as a failure`];
    }
    throw err;
  }

  const verdict = (response.content ?? '').trim().toUpperCase();
  if (verdict.startsWith('PASS')) return [];
  if (verdict.startsWith('FAIL')) return [`rubric not met: ${rubric}`];
  return [
    `rubric judge returned "${verdict}" (stop: ${response.stopReason ?? 'unknown'}), `
    + 'which is neither PASS nor FAIL — treated as a failure',
  ];
}

/** Run one case live against a hired agent, through the test-harness router. */
async function recordCase(
  ev: TemplateEval,
  opts: { baseUrl: string; token: string; tenantId: string; agentId: string; templateId: string; provider?: string },
): Promise<CaseRecording> {
  if (opts.provider && !ev.trigger) {
    throw new Error(`--provider applies to triggered cases only; ${ev.id} is a chat case`);
  }
  // A TRIGGER case's turns are separate DELIVERIES; a chat case's are one
  // conversation.
  //
  // Joining was right for chat and wrong for triggers, and the difference is
  // where the state a case is about actually lives. A chat case's context is
  // the conversation, which a second run would lose. A trigger case's context
  // is the action ledger, which PERSISTS across runs — so the only way to test
  // "the same event arriving twice" is to send it twice. Joined into one
  // prompt, the second delivery was never a delivery at all, and a case about
  // redelivery could only be satisfied by narrating a past that had not
  // happened.
  const withContext = (turn: string): string =>
    ev.state ? `${turn}\n\nContext:\n${JSON.stringify(ev.state, null, 2)}` : turn;
  const prompts = ev.trigger
    ? ev.turns.map(withContext)
    : [withContext(ev.turns.join('\n'))];

  // The harness router mounts under /api/internal and authenticates with
  // X-Service-Auth, not a bearer token — it deliberately sits outside
  // authMiddleware so an internal caller needs no Firebase session.
  const deliveries: DeliveryRecording[] = [];
  let lastBody: AgentHarnessRunResult | null = null;
  for (const prompt of prompts) {
    const res = await fetch(`${opts.baseUrl}/api/internal/test-harness/run-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-auth': opts.token },
      // A case that declares a trigger is run as one. Without this the harness
      // drives a chat turn for every case, which is the wrong entry point for any
      // role that wakes on an event — and the reason the code-reviewer's review
      // cases could not pass however they were asserted.
      body: JSON.stringify({
        tenantId: opts.tenantId,
        agentId: opts.agentId,
        prompt,
        ...(ev.trigger ? { trigger: ev.trigger } : {}),
        // The provider alone; the model then resolves to that family's medium
        // tier, the same way a hire with no pinned model resolves.
        ...(opts.provider ? { modelConfigOverride: { provider: opts.provider, tier: 'medium' } } : {}),
      }),
    });

    const body = (await res.json()) as AgentHarnessRunResult;
    lastBody = body;
    const calls = (body.toolCalls ?? []).map((c) => effectiveToolCall(c as { toolName: string; args?: unknown }));
    deliveries.push({
      toolNames: calls.map((c) => c.toolName),
      // The harness populates args/result/error; only the names were kept.
      toolArgs: calls,
      finalText: body.finalText ?? '',
      outcome: body.outcome ?? null,
      ...(body.invocationId ? { invocationId: body.invocationId } : {}),
    });
  }

  // The flattened view is the union across deliveries, so every expectation
  // written before this stays true of the same run and keeps meaning what it
  // meant. `deliveries` is the addition, for the assertions that are about WHEN.
  const toolNames = deliveries.flatMap((d) => d.toolNames);
  return {
    caseId: ev.id,
    templateId: opts.templateId,
    recordedAt: new Date().toISOString(),
    finalText: deliveries.map((d) => d.finalText).filter(Boolean).join('\n\n'),
    toolNames,
    toolArgs: deliveries.flatMap((d) => d.toolArgs),
    skillLoads: toolNames.filter((n) => matchBareName(n, 'read_skill')),
    outcome: lastBody?.outcome ?? null,
    deliveries,
    ...(lastBody?.error ? { error: lastBody.error } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
}

function recordingDir(templateId: string, provider: string | undefined): string {
  return provider ? join(RECORDINGS, templateId, provider) : join(RECORDINGS, templateId);
}

function recordingPath(templateId: string, caseId: string, provider: string | undefined): string {
  return join(recordingDir(templateId, provider), `${caseId}.json`);
}

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const templateId = arg('template');
  const provider = arg('provider');
  // One case, by id. A trigger case can pin a fixture the CATALOG shares with
  // its siblings at a different revision — the code-reviewer's PR 123 is
  // reviewed at one head by the redelivery case and at a later head by the
  // new-head case, and a branch has one tip at a time — so the recording has
  // to be able to stop between cases while the fixture moves. The check still
  // reports every case, so a case recorded in an earlier run is not lost.
  const only = arg('case');
  const record = process.argv.includes('--record');
  const replay = process.argv.includes('--replay');

  if (!templateId || (!record && !replay)) {
     
    console.error('Usage: --template <id> [--provider <family>] [--case <id>] (--record --tenant <uuid> --agent <uuid> | --replay)');
    process.exit(1);
  }

  initTemplateLoader(join(__dirname, '..', 'agent-templates', 'catalog'));
  const template = getTemplate(templateId);
  if (!template) throw new Error(`No template "${templateId}"`);
  const evals = template.evals ?? [];
  if (evals.length === 0) throw new Error(`Template "${templateId}" declares no evals`);
  if (only && !evals.some((e) => e.id === only)) throw new Error(`Template "${templateId}" declares no case "${only}"`);

  if (record) {
    // The same refusal distill-ab-harness carries, for the same reason: these
    // are real runs against whatever the agent is bound to.
    const env = process.env.NODE_ENV ?? process.env.ENVIRONMENT ?? '';
    if (env === 'production' || (process.env.DATABASE_URL ?? '').includes('prod')) {
      throw new Error('template-eval-harness records live runs and refuses to run outside dev');
    }
    const tenantId = arg('tenant');
    const agentId = arg('agent');
    const baseUrl = process.env.PB_BASE_URL ?? 'https://api-dev.example.com';
    const token = process.env.TEST_HARNESS_SERVICE_TOKEN
      ?? process.env.TENANT_RUNTIME_SERVICE_TOKEN
      ?? '';
    if (!tenantId || !agentId) throw new Error('--record needs --tenant and --agent');
    if (!token) throw new Error('--record needs TEST_HARNESS_SERVICE_TOKEN or TENANT_RUNTIME_SERVICE_TOKEN');

    mkdirSync(recordingDir(templateId, provider), { recursive: true });
    for (const ev of evals) {
      if (only && ev.id !== only) continue;
      // ONE case failing must not discard the others.
      //
      // A live case is minutes of agent time and real money, and the whole
      // reason recording is separate from checking is so a failure costs one
      // case rather than the run. Letting a transient `fetch failed` throw here
      // lost two completed recordings and reported nothing at all — which is
      // the most expensive possible way to learn that the network blipped.
      try {
        const rec = await recordCase(ev, { baseUrl, token, tenantId, agentId, templateId, provider });
        writeFileSync(recordingPath(templateId, ev.id, provider), JSON.stringify(rec, null, 2));
        log.info(
          { templateId, caseId: ev.id, provider, tools: rec.toolNames.length, invocations: rec.deliveries?.map((d) => d.invocationId) },
          'recorded eval case',
        );
      } catch (err) {
        log.warn(
          { templateId, caseId: ev.id, err: (err as Error).message },
          'recording failed for this case; the others still run and the report says so',
        );
      }
    }
  }

  // ── Check ──────────────────────────────────────────────────────────────
  const results: Array<{ ev: TemplateEval; failures: string[]; rec?: CaseRecording }> = [];
  for (const ev of evals) {
    const path = recordingPath(templateId, ev.id, provider);
    if (!existsSync(path)) {
      results.push({
        ev,
        failures: ['NOT RECORDED — this case never produced a run, so it is neither passing nor failing'],
      });
      continue;
    }
    const rec = JSON.parse(readFileSync(path, 'utf8')) as CaseRecording;
    const failures = checkExpectation(ev.expected, rec);
    if (ev.expected.rubric) {
      failures.push(...await gradeRubric(ev.expected.rubric, rec, arg('tenant') ?? 'unknown'));
    }
    results.push({ ev, failures, rec });
  }

  report(provider ? `${templateId} on ${provider}` : templateId, results);
  process.exit(results.some((r) => r.failures.length > 0) ? 1 : 0);
}

function report(
  templateId: string,
  results: Array<{ ev: TemplateEval; failures: string[]; rec?: CaseRecording }>,
): void {
  const line = (s: string): void => {
     
    console.log(s);
  };
  const passed = results.filter((r) => r.failures.length === 0).length;
  line(`\n${templateId}: ${passed}/${results.length} cases pass\n`);

  for (const { ev, failures, rec } of results) {
    line(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${ev.id}`);
    for (const f of failures) line(`        ${f}`);
    // The observed route, printed on a failure and never offered as a fix.
    // Re-pinning an eval to what the model happened to do is how a suite stops
    // measuring anything, so the report shows the route and stops there.
    if (failures.length > 0 && rec) {
      line(`        observed route: ${rec.toolNames.join(' → ') || 'no tool calls'}`);
    }
  }

  // Pairs, reported together. A refusal case that passes while its served
  // counterpart fails is an agent refusing everything, and reading the two
  // separately is exactly how that gets missed.
  const byId = new Map(results.map((r) => [r.ev.id, r]));
  const pairs = results.filter((r) => r.ev.counterpartOf);
  if (pairs.length > 0) line('');
  for (const r of pairs) {
    const other = byId.get(r.ev.counterpartOf!);
    if (!other) continue;
    const both = r.failures.length === 0 && other.failures.length === 0;
    line(
      `${both ? 'PAIR OK' : 'PAIR BROKEN'}  ${other.ev.id} ↔ ${r.ev.id}`
      + (both ? '' : '  — a half-passing pair says nothing about judgement'),
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    log.error({ err: (err as Error).message }, 'template-eval-harness failed');
    process.exit(1);
  });
}
