// FITNESS FUNCTION — the sandbox path is reachable in the SPLIT deployment.
//
// Everything else about `CODE_SESSION_EXECUTION=sandbox` can be tested in
// process: the protocol, the runners, the classification. None of it notices
// whether, in a split deployment, the flag does anything at all.
//
// `code_session` asks the tool-gateway singleton for a sandbox executor, and it
// runs in the AGENT service — agent-execution/service.ts assembles the MCP
// catalog, so the tool's handler executes there. But the executor client was
// wired only when a process `ownsToolGatewayRoutes`, which for `SERVICE_TYPE=agent`
// is false, and `SANDBOX_EXECUTOR_URL` was patched onto tool-gateway-service and
// sandbox-executor but never onto agent-service.
//
// Both halves had to be true for the flag to do anything, and neither was. The
// failure is silent by construction: `openCodeSessionWorkspace` falls back to
// the in-process workspace and logs
// `code_session_sandbox_requested_but_unavailable`, so a coding session still
// runs, still works, and still executes in the runtime's own container under
// the runtime's service account — which is the exact thing the flag exists to
// stop.
//
// Asserted against source because it is boot wiring and a deploy script; there
// is no unit to call. That is also why it is worth pinning: nothing else looks
// at these two lines together.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const INDEX = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
const CLOUDBUILD = readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8');

describe('the agent service can reach a sandbox', () => {
  it('wires the executor client when it owns agent routes', () => {
    // `ownsToolGatewayRoutes` alone is the bug. `SERVICE_TYPE=agent` does not
    // own tool-gateway routes, and that is the service code_session runs in.
    expect(INDEX).toContain(
      'if ((ownsAgentRoutes || ownsToolGatewayRoutes) && !ownsSandboxExecutor) {',
    );
  });

  it('sets the executor URL in the step that runs on EVERY deploy', () => {
    // NOT patch-split-service-urls. That step opens with
    //
    //   if [ -n "$$AGENT_URL" ] && … && [ -n "$$SANDBOX_EXEC_URL" ]; then
    //     echo "All peer URLs were known at deploy time — nothing to patch."
    //     exit 0
    //
    // so it runs only on the first-ever deploy of a tenant project. An earlier
    // version of this test looked there, passed, and the variable was still
    // absent from the running service — the flag was on and the sandbox
    // unreachable, with only `code_session_sandbox_requested_but_unavailable`
    // in the logs to say so.
    //
    // The property is that agent-service gets it from its OWN --set-env-vars,
    // which is the line every deploy executes.
    const script = CLOUDBUILD
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const deployStep = script.split('gcloud run deploy agent-service')[1] ?? '';
    const setEnv = deployStep
      .split('\n')
      .find((l) => l.includes('--set-env-vars'));
    expect(setEnv).toBeDefined();
    expect(setEnv).toContain('SANDBOX_EXECUTOR_URL=$$SANDBOX_EXEC_URL_VAL');

    // And the value is defined earlier in the SAME step, with the placeholder
    // guard its siblings use, so a first-ever deploy does not set an empty
    // string on a service that would then fail its https:// validator.
    const stepBody = script
      .split("id: 'deploy-agent-service'")[1]
      ?.split('gcloud run deploy agent-service')[0] ?? '';
    expect(stepBody).toContain('SANDBOX_EXEC_URL_VAL=$${SANDBOX_EXEC_URL:-placeholder');
  });

  it('the deploy SETS the mode, and sets it per environment', () => {
    // Reachable is not the same as on. Everything above proves the sandbox
    // could be reached IF the flag were set, and a flag set by no deploy step
    // leaves the substrate dormant in every environment.
    //
    // Setting it by hand does not survive: `--set-env-vars` REPLACES the whole
    // set rather than merging, so the next deploy of any other change silently
    // reverts the mode, and the logs then look as if nobody had used the tool.
    const script = CLOUDBUILD
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const setEnv = (script.split('gcloud run deploy agent-service')[1] ?? '')
      .split('\n')
      .find((l) => l.includes('--set-env-vars'));
    // The deploy arg is ONE Cloud Build argument with a 10,000-character cap,
    // so the per-environment choice is resolved in `resolve-operator-flags` and
    // carried here by name. Both halves are asserted: an arg that names a
    // variable nothing sets writes an EMPTY value, which reads as the default.
    expect(setEnv).toContain('CODE_SESSION_EXECUTION=$$CODE_SESSION_EXEC_VAL');
    expect(script).toContain(
      'CODE_SESSION_EXEC_VAL=$([ "${_ENVIRONMENT}" = "prod" ] && echo inprocess || echo sandbox)',
    );
    expect(script).toContain('CODE_SESSION_EXEC_VAL=$$CODE_SESSION_EXEC_VAL');

    // And the two words the deploy writes are the two words the switch reads.
    // They are compared across a shell string and a TypeScript literal, which
    // is exactly the seam where a rename goes unnoticed: renaming the mode in
    // one place leaves the other setting a value that silently means default.
    const factory = readFileSync(join(__dirname, '..', 'open-workspace.ts'), 'utf8');
    expect(factory).toContain(
      "process.env.CODE_SESSION_EXECUTION === 'sandbox' ? 'sandbox' : 'inprocess'",
    );
  });

  it('the deploy SETS which CLI the open-weights vendors code with', () => {
    // Same shape as the mode above, and the same reason it needs a guard: both
    // environments code with `opencode`. Unset means codex, so a variable that silently resolves to
    // nothing would quietly put every open-weights session back on Codex.
    const script = CLOUDBUILD
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const setEnv = (script.split('gcloud run deploy agent-service')[1] ?? '')
      .split('\n')
      .find((l) => l.includes('--set-env-vars'));
    expect(setEnv).toContain('CODE_SESSION_OPEN_WEIGHTS_RUNNER=$$CODE_SESSION_RUNNER_VAL');
    expect(script).toContain('CODE_SESSION_RUNNER_VAL=opencode');
    expect(script).toContain('CODE_SESSION_RUNNER_VAL=$$CODE_SESSION_RUNNER_VAL');

    // The word the deploy writes is the word the switch reads, across a shell
    // string and a TypeScript literal — the seam where a rename goes unnoticed.
    const runner = readFileSync(join(__dirname, '..', 'runners', 'openrouter.ts'), 'utf8');
    expect(runner).toContain(
      "process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER === 'opencode' ? 'opencode' : 'codex'",
    );
  });

  it('the fallback is loud, so a misconfiguration is visible in logs', () => {
    // The fallback itself is correct — a connector-only deployment has no
    // sandbox and code_session should still work. What must never happen is
    // falling back SILENTLY, because then the flag reads as on while the
    // coding agent runs in the runtime's container.
    const factory = readFileSync(
      join(__dirname, '..', 'open-workspace.ts'),
      'utf8',
    );
    expect(factory).toContain('code_session_sandbox_requested_but_unavailable');
    expect(factory).toContain('code_session_workspace_sandboxed');
  });
});
