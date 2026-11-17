/**
 * Code-execution failures are the agent's own script failing, not a broken tool.
 *
 * The §7.3 fast-trip escalates after PERMANENT_FAILURE_CAP non-retryable errors
 * on the same tool. That is right for connector tools, which fail identically
 * however they are called (auth expired, resource gone). It is wrong for a
 * shell, whose exit code reports what the generated script did.
 *
 * The classifier reads stderr text, so it cannot tell the difference:
 *   "Exit code 1 ... SyntaxError: Unexpected token"      → internal_error, retryable false
 *   "Exit code 127 ... python3: command not found"       → not_found,      retryable false
 * Both are ordinary, self-correctable mistakes — probing for a binary that is
 * not installed, or a bug in a script the agent just wrote. Under the cap, two
 * of them end the run — which can kill a run that has already fetched every
 * record it needs and is on its final write step.
 *
 * Writing a corrected script IS the retry, so these must not count toward the
 * cap. The engine cannot be imported here (it pulls DB + SDK transitively), so
 * this asserts the guard directly, as the other *.source tests in this repo do.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

describe('code-execution tools are exempt from the permanent-failure cap', () => {
  it('declares the exempt set and includes the shell', () => {
    const decl = SOURCE.match(/CODE_EXECUTION_TOOLS = new Set\(\[([^\]]*)\]\)/);
    expect(decl).not.toBeNull();
    expect(decl![1]).toContain("'Bash'");
  });

  it('the permanent-failure guard skips those tools', () => {
    // The counter must not increment for a shell, or two scripting mistakes
    // escalate and terminate the run.
    const guard = SOURCE.includes(
      "contract.retryable === false && !CODE_EXECUTION_TOOLS.has(input.context.toolName ?? '')",
    );
    expect(guard).toBe(true);
  });

  it('still escalates on repeated permanent failures for other tools', () => {
    // The fast-trip itself is deliberately kept: a connector that is genuinely
    // unreachable should not burn recovery turns.
    expect(SOURCE).toContain('const PERMANENT_FAILURE_CAP = 2');
    expect(SOURCE).toContain('permanent tool error x');
  });
});

describe('a malformed call is the model\'s to fix, never a permanent failure', () => {
  const handler = SOURCE.slice(
    SOURCE.indexOf('engine.registerAnomalyHandler(async (input) => {'),
    SOURCE.indexOf('engine.registerToolBatchHandler!'),
  );

  it('the model-authored branch is decided before the permanent guard', () => {
    // An enveloped invalid_arguments is retryable:false, so the permanent
    // guard would take it first and count the model's own mistake as a
    // broken connector. Order is the rule here.
    const modelAuthoredAt = handler.indexOf("contract?.code === MODEL_AUTHORED_TOOL_ERROR_CODE");
    const permanentGuardAt = handler.indexOf(
      "contract.retryable === false && !CODE_EXECUTION_TOOLS.has(input.context.toolName ?? '')",
    );
    expect(modelAuthoredAt).toBeGreaterThan(-1);
    expect(permanentGuardAt).toBeGreaterThan(modelAuthoredAt);
  });

  it('strikes are keyed on the call, through the ledger, on both branches', () => {
    expect(handler).toContain("const callKey = callSignature(toolKey, input.context.args)");
    expect(handler).toContain("strikes.reject({ key: callKey, callId: input.context.callId, kind: 'malformed' })");
    expect(handler).toContain("strikes.reject({ key: callKey, callId: input.context.callId, kind: 'permanent'");
    expect(handler).not.toContain('permanentFailureCounts');
  });

  it('the recovery budget is spent only where a recovery model runs', () => {
    // Both no-model corrections return before this line; the cap that bounds
    // recovery-LLM turns must not be consumed by corrections that make none.
    const capAt = handler.indexOf('if (perStep >= PER_STEP_CAP || recoveryCounters.total >= TOTAL_CAP)');
    const recoveryAt = handler.indexOf("kind: 'recovery'");
    expect(recoveryAt).toBeGreaterThan(-1);
    expect(capAt).toBeGreaterThan(recoveryAt);
  });
});
