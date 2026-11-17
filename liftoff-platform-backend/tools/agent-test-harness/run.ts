#!/usr/bin/env node
// PB-side agent-test-harness CLI runner.
//
// Posts each scenario from @liftoffos/agent-test-scenarios at PB's
// POST /api/internal/test-harness/run-chat — the END-TO-END probe that
// goes through runAgentChatTurn → tenantRuntimeClient.runChatTurnStream
// → TR's chat-turn handler. Complements the TR-side runner (which
// drives executeTask directly inside TR for the execution-layer probe).
//
// Detail parity: this surface enables traceMode=true server-side so the
// returned AgentHarnessRunResult carries the FULL detail set (per-call
// args, result, error, usage, the agent's exposed tool catalog). The
// shared assertScenario() works the same against responses from either
// surface.
//
// Usage:
//   ts-node tools/agent-test-harness/run.ts \
//     --base=https://api.example.com \
//     --tenant=<uuid> \
//     --agent=<uuid> \
//     [--tag=<name>] [--id=<scenario>] [--user-account=<uuid>] \
//     [--service-token=<value> | --secret-project=<gcp-project>] \
//     [--impersonate-sa=<sa-email>]
//
// Auth model mirrors the TR-side runner:
//   1. Authorization: Bearer <id-token>  — Cloud Run IAM (audience-scoped
//      ID token impersonated from --impersonate-sa).
//   2. X-Service-Auth: <token>           — PB's app-level service-auth
//      gate. Accepts TENANT_RUNTIME_SERVICE_TOKEN or a future
//      TEST_HARNESS_SERVICE_TOKEN.

import { execSync } from 'node:child_process';
import {
  SCENARIOS,
  assertScenario,
  matchBareName,
  type AgentTestScenario,
  type AgentHarnessRunResult,
} from '@liftoffos/agent-test-scenarios';

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
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.+)$/i.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'base') args.base = v;
    if (k === 'tenant') args.tenant = v;
    if (k === 'agent') args.agent = v;
    if (k === 'tag') args.tag = v;
    if (k === 'id') args.id = v;
    if (k === 'user-account') args.userAccount = v;
    if (k === 'service-token') args.serviceToken = v;
    if (k === 'secret-project') args.secretProject = v;
    if (k === 'impersonate-sa') args.impersonateSa = v;
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
    // The PB service-auth gate accepts the tenant-runtime service token.
    // Same secret is used on both sides; CI provisions it identically.
    return execSync(
      `gcloud secrets versions access latest --secret=tenant-runtime-service-token --project=${cli.secretProject}`,
      { encoding: 'utf8' },
    ).trim();
  }
  throw new Error('No service token. Provide --service-token=<value>, set TR_SERVICE_TOKEN env, or pass --secret-project=<gcp-project>.');
}

interface ClientHarnessResponse extends AgentHarnessRunResult {
  /** Set client-side when the response wasn't JSON. */
  _httpStatus?: number;
  _rawSnippet?: string;
}

async function runScenario(
  cli: CliArgs,
  serviceToken: string,
  idToken: string | null,
  scenario: AgentTestScenario,
): Promise<ClientHarnessResponse> {
  const url = `${cli.base}/api/internal/test-harness/run-chat`;
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

  // Same retry policy as the TR-side runner — Cloud Run cold starts
  // give 503s; slow tools give 504s. ALSO retry pre-HTTP network
  // errors (undici `fetch failed` for connect timeout / socket
  // reset / refused) which previously fell through the cracks because
  // the RETRYABLE_HTTP set only matches HTTP statuses.
  const MAX_ATTEMPTS = 3;
  const RETRYABLE_HTTP = new Set([502, 503, 504]);
  let lastJson: ClientHarnessResponse | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
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
  const idToken = cli.impersonateSa ? getIdToken(audience, cli.impersonateSa) : null;

  const filtered = SCENARIOS.filter((s) => {
    if (cli.id && s.id !== cli.id) return false;
    if (cli.tag && !(s.tags ?? []).includes(cli.tag)) return false;
    return true;
  });
  if (filtered.length === 0) {
    console.error('no scenarios matched the filter');
    process.exit(2);
  }

  console.log(`# pb-agent-test-harness — ${filtered.length} scenario(s) → ${cli.base}`);
  console.log(`# tenant=${cli.tenant} agent=${cli.agent}\n`);

  // Pace setup-using scenarios so back-to-back Anchor spawns don't
  // exhaust the account-level concurrent-session quota.
  const ANCHOR_PACE_MS = 5_000;
  let lastSetupAt = 0;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
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
      const resp = await runScenario(cli, serviceToken, idToken, scenario);
      // Defensive: server-side error responses may omit toolCalls /
      // exposedToolNames if the failure happens before the assembler
      // populates them. Coerce to empty arrays so the table formatter
      // and the assertion don't crash on .map / .length.
      resp.toolCalls = resp.toolCalls ?? [];
      resp.exposedToolNames = resp.exposedToolNames ?? [];
      const assertion = assertScenario(scenario, resp);
      const calledSummary = resp.toolCalls.map((c) => c.toolName.replace(/^mcp__[^_]+__/, '')).join(' → ') || '(none)';
      if (resp.setup?.steps?.length) {
        console.log(`    setup        : ${resp.setup.steps.join(' | ')}`);
      }
      console.log(`    tools called : ${calledSummary}`);
      console.log(`    tokens       : in=${resp.inputTokens} out=${resp.outputTokens} cached=${resp.cachedTokens}`);
      console.log(`    duration_ms  : ${resp.durationMs}`);
      if (assertion.status === 'pass') {
        console.log(`    ✅ PASS\n`);
        passed++;
      } else if (assertion.status === 'skip') {
        console.log(`    ⏭  SKIP`);
        for (const r of assertion.skipReasons ?? []) console.log(`       - ${r}`);
        console.log(`    exposed_tools: ${resp.exposedToolNames.join(', ') || '(none)'}\n`);
        skipped++;
      } else {
        console.log(`    ❌ FAIL`);
        for (const f of assertion.failures) console.log(`       - ${f}`);
        if (resp.finalText) console.log(`    final_text   : ${resp.finalText.slice(0, 200)}${resp.finalText.length > 200 ? '…' : ''}`);
        console.log(`    invocation   : ${resp.invocationId}\n`);
        failed++;
      }
    } catch (e) {
      console.log(`    ❌ FAIL — harness error: ${(e as Error).message}\n`);
      failed++;
    }
    // Silence the unused-variable lint on the helper imported alongside the runner.
    void matchBareName;
  }

  console.log(`\n## summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
