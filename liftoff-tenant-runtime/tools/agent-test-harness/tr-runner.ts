#!/usr/bin/env node
// TR-side agent-test-harness CLI runner — EXECUTION-LAYER probe.
//
// Posts each scenario from @liftoffos/agent-test-scenarios at TR's
// POST /api/internal/test-harness/run-agent — direct call into
// executeTask via the test-harness router. Returns the assembled
// AgentHarnessRunResult with full args / result / usage detail.
//
// Complements the PB-side runner (tools/agent-test-harness/run.ts in
// platform-backend) which posts at PB's run-chat endpoint and drives
// the SAME scenarios through the END-TO-END chat path. Same scenario
// definitions, same assertScenario(), two probe surfaces.
//
// Usage:
//   ts-node tools/agent-test-harness/run.ts \
//     --base=https://agent-service-<...>.run.app \
//     --tenant=<uuid> --agent=<uuid> \
//     [--tag=<name>] [--id=<scenario>] [--user-account=<uuid>] \
//     [--service-token=<value> | --secret-project=<gcp-project>] \
//     [--impersonate-sa=<sa-email>]
//
// Auth: Authorization: Bearer <impersonated ID token> (Cloud Run IAM)
// + X-Service-Auth: TENANT_RUNTIME_SERVICE_TOKEN (app-level gate).

import { execSync } from 'node:child_process';
import {
  SCENARIOS,
  ADVERSARIAL_SCENARIOS,
  SWE_SCENARIOS,
  assertScenario,
  matchBareName,
  type AgentTestScenario,
  type AgentHarnessRunResult,
} from '@liftoffos/agent-test-scenarios';
import { matchesTagFilter } from './tag-filter';
import {
  fetchGithubRunState,
  resetGithubFixture,
  findOpenRunPr,
  seedReviewComment,
  evaluateExternalChecks,
  teardownGithubRun,
  substituteRunId,
  RUN_BRANCH_PREFIX,
} from './external-checks';

// The base suite plus the adversarial safety suite (assertion-based: HITL-pause / tool-absence /
// audit state). The SWE suite is unioned in main() ONLY under `--external-checks=github` — its
// scenarios need a live fixture repo + token, and their `externalChecks` are polled post-run.
const BASE_SCENARIOS: AgentTestScenario[] = [...SCENARIOS, ...ADVERSARIAL_SCENARIOS];

interface CliArgs {
  base: string;
  tenant: string;
  agent: string;
  tag?: string;
  id?: string;
  userAccount?: string;
  serviceToken?: string;
  secretProject?: string;
  impersonateSa?: string;
  oidc?: boolean; // fetch an ID token from the CURRENT identity (no impersonation) — for CI SAs that hold run.invoker directly
  externalChecks?: string; // 'github' — poll the fixture repo for the run's post-run side effects
  fixtureRepo?: string; // owner/name; defaults to DIAGNOSTICS_FIXTURE_REPO
  fixtureTokenSecret?: string; // Secret Manager secret holding the GitHub fixture token (fetched via --secret-project)
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (const a of argv) {
    // Bare boolean flags (no =value).
    if (a === '--oidc') { args.oidc = true; continue; }
    const m = /^--([a-z-]+)=(.+)$/i.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'oidc') args.oidc = v === 'true' || v === '1';
    if (k === 'base') args.base = v;
    if (k === 'tenant') args.tenant = v;
    if (k === 'agent') args.agent = v;
    if (k === 'tag') args.tag = v;
    if (k === 'id') args.id = v;
    if (k === 'user-account') args.userAccount = v;
    if (k === 'service-token') args.serviceToken = v;
    if (k === 'secret-project') args.secretProject = v;
    if (k === 'impersonate-sa') args.impersonateSa = v;
    if (k === 'external-checks') args.externalChecks = v;
    if (k === 'fixture-repo') args.fixtureRepo = v;
    if (k === 'fixture-token-secret') args.fixtureTokenSecret = v;
  }
  if (!args.base || !args.tenant || !args.agent) {
    console.error('usage: run.ts --base=<url> --tenant=<uuid> --agent=<uuid> [--tag=<name>] [--id=<scenario>] [--user-account=<uuid>] [--service-token=<token> | --secret-project=<gcp-project>] [--impersonate-sa=<sa-email>]');
    process.exit(2);
  }
  return args as CliArgs;
}

function getIdToken(audience: string, impersonateSa?: string): string {
  const impersonate = impersonateSa ? `--impersonate-service-account=${impersonateSa}` : '';
  return execSync(`gcloud auth print-identity-token --audiences=${audience} ${impersonate}`, { encoding: 'utf8' }).trim();
}

function getServiceToken(cli: CliArgs): string {
  if (cli.serviceToken) return cli.serviceToken;
  if (process.env.TR_SERVICE_TOKEN) return process.env.TR_SERVICE_TOKEN;
  if (cli.secretProject) {
    return execSync(
      `gcloud secrets versions access latest --secret=tenant-runtime-service-token --project=${cli.secretProject}`,
      { encoding: 'utf8' },
    ).trim();
  }
  throw new Error('No service token. Provide --service-token=<value>, set TR_SERVICE_TOKEN env, or pass --secret-project=<gcp-project>.');
}

// The GitHub fixture token for --external-checks=github. Prefers the env var (local dev); in CI it is
// fetched from Secret Manager the same way as the service token, via --fixture-token-secret + --secret-project.
function getFixtureToken(cli: CliArgs): string {
  if (process.env.GITHUB_FIXTURE_TOKEN) return process.env.GITHUB_FIXTURE_TOKEN;
  if (cli.fixtureTokenSecret && cli.secretProject) {
    return execSync(
      `gcloud secrets versions access latest --secret=${cli.fixtureTokenSecret} --project=${cli.secretProject}`,
      { encoding: 'utf8' },
    ).trim();
  }
  return '';
}

interface ClientHarnessResponse extends AgentHarnessRunResult {
  _httpStatus?: number;
  _rawSnippet?: string;
}

async function runScenario(
  cli: CliArgs,
  serviceToken: string,
  idToken: string | null,
  scenario: AgentTestScenario,
): Promise<ClientHarnessResponse> {
  const url = `${cli.base}/api/internal/test-harness/run-agent`;
  const body = {
    tenantId: cli.tenant,
    agentId: cli.agent,
    prompt: scenario.prompt,
    ...(cli.userAccount ? { userAccountId: cli.userAccount } : {}),
    ...(scenario.maxTurns !== undefined ? { maxTurns: scenario.maxTurns } : {}),
    ...(scenario.setup ? { setup: scenario.setup } : {}),
  };
  const headers: Record<string, string> = {
    'x-service-auth': serviceToken,
    'content-type': 'application/json',
  };
  if (idToken) headers['authorization'] = `Bearer ${idToken}`;

  const MAX_ATTEMPTS = 3;
  const RETRYABLE_HTTP = new Set([502, 503, 504]);
  let lastJson: ClientHarnessResponse | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      // Node's undici fetch throws on network errors BEFORE there's an
      // HTTP status — so the RETRYABLE_HTTP set never sees them. The
      // typical class is `fetch failed` (TypeError from undici), wrapping
      // a UND_ERR_SOCKET / ENOTFOUND / ECONNRESET / ECONNREFUSED on the
      // socket. Cold-starting Cloud Run instances + a 5-second undici
      // connect timeout drives most of the harness's `fetch failed`
      // observations. Treat these the same as HTTP 5xx: backoff and
      // retry. Only surface the failure if all attempts exhaust.
      if (attempt === MAX_ATTEMPTS) {
        return {
          ok: false,
          error: 'fetch_failed',
          message: (err as Error).message,
          invocationId: '',
          threadId: '',
          finalText: '',
          toolCalls: [],
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          outcome: null,
          exposedToolNames: [],
          durationMs: 0,
        };
      }
      const delayMs = attempt === 1 ? 3_000 : 8_000;
      process.stdout.write(`    (retry: fetch failed on attempt ${attempt} (${(err as Error).message}), waiting ${delayMs}ms)\n`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    const text = await res.text();
    let json: ClientHarnessResponse;
    try {
      json = JSON.parse(text) as ClientHarnessResponse;
    } catch {
      json = {
        ok: false,
        error: 'non_json_response',
        message: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        invocationId: '',
        threadId: '',
        finalText: '',
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        outcome: null,
        exposedToolNames: [],
        durationMs: 0,
        httpStatus: res.status,
        rawSnippet: text.slice(0, 200),
      };
    }
    if (!res.ok && json.ok !== false) {
      json.ok = false;
      json.error = json.error ?? `http_${res.status}`;
      json.httpStatus = res.status;
    }
    lastJson = json;
    if (res.ok || !RETRYABLE_HTTP.has(res.status) || attempt === MAX_ATTEMPTS) return json;
    const delayMs = attempt === 1 ? 3_000 : 8_000;
    process.stdout.write(`    (retry: HTTP ${res.status} on attempt ${attempt}, waiting ${delayMs}ms)\n`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastJson!;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const serviceToken = getServiceToken(cli);
  const audience = new URL(cli.base).origin;
  // agent-service is no-allow-unauthenticated, so it needs an OIDC ID token. Fetch one either by
  // impersonating a run.invoker SA (--impersonate-sa) or from the current identity (--oidc), which
  // suits CI service accounts that hold run.invoker directly (e.g. the cloud-build SA).
  const idToken = cli.impersonateSa || cli.oidc ? getIdToken(audience, cli.impersonateSa) : null;

  // C4 external-checks: only under --external-checks=github do we union the SWE suite and poll the
  // fixture repo for each run's side effects. Needs a fixture repo + a token both env/flag-provided.
  const externalMode = cli.externalChecks === 'github';
  const fixtureRepo = cli.fixtureRepo || process.env.DIAGNOSTICS_FIXTURE_REPO || '';
  const ghToken = getFixtureToken(cli);
  const runId = process.env.BUILD_ID || `local-${Date.now().toString(36)}`;
  const branchPrefix = substituteRunId(RUN_BRANCH_PREFIX, runId);
  if (externalMode) {
    if (!fixtureRepo) { console.error('--external-checks=github requires --fixture-repo=<owner/name> or DIAGNOSTICS_FIXTURE_REPO'); process.exit(2); }
    if (!ghToken) { console.error('--external-checks=github requires GITHUB_FIXTURE_TOKEN in the environment, or --fixture-token-secret=<name> with --secret-project'); process.exit(2); }
    console.log(`# external-checks: github repo=${fixtureRepo} runId=${runId} branchPrefix=${branchPrefix}`);
    // Reset the fixture to its baseline before the run so scenarios are repeatable — a prior run's
    // merge fixes the defect and auto-closes the issue, which would leave later runs nothing to do.
    const resetNotes = await resetGithubFixture(fixtureRepo, ghToken);
    if (resetNotes.length) console.log(`# fixture reset: ${resetNotes.join(' | ')}`);
  }

  const suite = externalMode ? [...BASE_SCENARIOS, ...SWE_SCENARIOS] : BASE_SCENARIOS;
  const filtered = suite.filter((s) => {
    if (cli.id && s.id !== cli.id) return false;
    if (!matchesTagFilter(s.tags ?? [], cli.tag)) return false;
    return true;
  });
  if (filtered.length === 0) {
    console.error('no scenarios matched the filter');
    process.exit(2);
  }

  console.log(`# tr-agent-test-harness — ${filtered.length} scenario(s) → ${cli.base}`);
  console.log(`# tenant=${cli.tenant} agent=${cli.agent}\n`);

  const ANCHOR_PACE_MS = 5_000;
  let lastSetupAt = 0;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // The open PR an earlier swe scenario opened, so later scenarios (review/merge/loop) name the
  // right repo + PR instead of defaulting to the agent connection's own account context.
  let runPr: { number: number; headSha: string; head: string } | null = null;
  const REVIEW_SCENARIOS = new Set(['swe.review_cycle_convergence', 'swe.loop_guard_no_trip']);
  for (const scenario of filtered) {
    if (scenario.setup?.browserSession !== undefined) {
      const sinceLast = Date.now() - lastSetupAt;
      if (lastSetupAt > 0 && sinceLast < ANCHOR_PACE_MS) {
        const waitMs = ANCHOR_PACE_MS - sinceLast;
        process.stdout.write(`  (pacing: waiting ${waitMs}ms before next setup to avoid Anchor 429)\n`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      lastSetupAt = Date.now();
    }
    process.stdout.write(`▸ ${scenario.id.padEnd(36)} ${scenario.description}\n`);
    try {
      const isSwe = (scenario.tags ?? []).includes('swe');
      // Before a swe scenario that operates on an existing PR, discover the one an earlier scenario
      // opened, and (for the review scenarios) seed a COMMENT review so there's feedback to reply to.
      if (externalMode && isSwe) {
        if (!runPr) runPr = await findOpenRunPr(fixtureRepo, runId, ghToken).catch(() => null);
        if (runPr && REVIEW_SCENARIOS.has(scenario.id)) {
          const notes = await seedReviewComment(fixtureRepo, runPr.number, runPr.headSha, ghToken);
          console.log(`    seed review  : ${notes.join(' | ')}`);
        }
      }
      let augmentedPrompt = scenario.prompt;
      if (externalMode && isSwe) {
        augmentedPrompt += `\n\nThe fixture repository is ${fixtureRepo}. Use the repository's GitHub tools (search for them if they are not already loaded — e.g. create_branch, create_or_update_file, create_pull_request, create_pull_request_review_comment, merge_pull_request) rather than shell git or another repository. Create every branch you make under the prefix "${branchPrefix}" (for example ${branchPrefix}issue-1-fix).`;
        if (runPr) augmentedPrompt += ` The open pull request for issue #1 is #${runPr.number} in ${fixtureRepo}.`;
      }
      const scenarioToRun: AgentTestScenario = isSwe ? { ...scenario, prompt: augmentedPrompt } : scenario;
      const resp = await runScenario(cli, serviceToken, idToken, scenarioToRun);
      resp.toolCalls = resp.toolCalls ?? [];
      resp.exposedToolNames = resp.exposedToolNames ?? [];
      // The harness's exposedToolNames is the EAGER catalog only; large tool sets defer some
      // connectors' tools to on-demand ToolSearch (e.g. GitHub forge tools when GitLab is eager).
      // A tool the agent actually called was, by definition, available — fold called tool names
      // into exposedToolNames so requiresExposedTools doesn't false-SKIP a deferred-but-used tool.
      resp.exposedToolNames = [...new Set([...resp.exposedToolNames, ...resp.toolCalls.map((c) => c.toolName)])];
      const assertion = assertScenario(scenario, resp);
      const calledSummary = resp.toolCalls.map((c) => c.toolName.replace(/^mcp__[^_]+__/, '')).join(' → ') || '(none)';
      if (resp.setup?.steps?.length) {
        console.log(`    setup        : ${resp.setup.steps.join(' | ')}`);
      }
      console.log(`    tools called : ${calledSummary}`);
      console.log(`    tokens       : in=${resp.inputTokens} out=${resp.outputTokens} cached=${resp.cachedTokens}`);
      console.log(`    duration_ms  : ${resp.durationMs}`);

      // C4: after the run's own assertion passes, confirm the side effect landed on the fixture repo.
      let externalFailures: string[] = [];
      if (externalMode && scenario.externalChecks && assertion.status === 'pass') {
        try {
          const state = await fetchGithubRunState(fixtureRepo, runId, ghToken);
          externalFailures = evaluateExternalChecks(scenario.externalChecks, state, runId).failures;
          console.log(`    external     : ${externalFailures.length === 0 ? 'ok' : externalFailures.length + ' failure(s)'}`);
        } catch (e) {
          externalFailures = [`external-check error: ${(e as Error).message}`];
        }
      }

      if (assertion.status === 'pass' && externalFailures.length === 0) {
        console.log(`    ✅ PASS\n`);
        passed++;
      } else if (assertion.status === 'skip') {
        console.log(`    ⏭  SKIP`);
        for (const r of assertion.skipReasons ?? []) console.log(`       - ${r}`);
        console.log(`    exposed_tools: ${resp.exposedToolNames.join(', ') || '(none)'}\n`);
        skipped++;
      } else {
        console.log(`    ❌ FAIL`);
        if (assertion.status === 'fail') for (const f of assertion.failures) console.log(`       - ${f}`);
        for (const f of externalFailures) console.log(`       - ${f}`);
        if (resp.finalText) console.log(`    final_text   : ${resp.finalText.slice(0, 200)}${resp.finalText.length > 200 ? '…' : ''}`);
        console.log(`    invocation   : ${resp.invocationId}\n`);
        failed++;
      }
    } catch (e) {
      console.log(`    ❌ FAIL — harness error: ${(e as Error).message}\n`);
      failed++;
    }
    void matchBareName;
  }

  if (externalMode && fixtureRepo && ghToken) {
    const notes = await teardownGithubRun(fixtureRepo, runId, ghToken);
    if (notes.length) console.log(`# teardown (${branchPrefix}*): ${notes.join(' | ')}`);
  }

  console.log(`\n## summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
