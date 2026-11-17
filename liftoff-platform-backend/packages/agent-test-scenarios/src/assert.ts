import type {
  AgentTestScenario,
  AgentHarnessRunResult,
  AssertionResult,
} from './types.js';

/**
 * Match a reported tool name against a "bare" name the scenario
 * declares. The MCP server prefixes tool names with the server id
 * (e.g. `mcp__liftoff-tool-gateway__run_browser_task`); scenarios are
 * authored against bare names so they don't have to know the prefix.
 * The Claude Agent SDK also surfaces its native tools by bare name
 * (e.g. `WebFetch`, `Bash`, `Agent`) — those pass through unchanged.
 */
export function matchBareName(reportedTool: string, bare: string): boolean {
  return reportedTool === bare || reportedTool.endsWith(`__${bare}`);
}

/**
 * Run all assertions for one scenario against the harness response.
 *
 * Resolution order (deliberate — each branch short-circuits later):
 *   1. requiresExposedTools missing in the catalog → SKIP. The agent
 *      literally couldn't call them; reporting FAIL would be
 *      misleading. (Only meaningful when exposedToolNames is
 *      populated — PB-side runs leave it empty and this branch is a
 *      no-op for them.)
 *   2. Run didn't succeed (HTTP error, agent error) → FAIL with the
 *      underlying reason surfaced.
 *   3. expectsTools / expectsOneOf / forbidsTools / text matchers →
 *      FAIL with the specific mismatch listed.
 *   4. Everything matched → PASS.
 */
export function assertScenario(
  scenario: AgentTestScenario,
  resp: AgentHarnessRunResult,
): AssertionResult {
  const failures: string[] = [];

  if (scenario.requiresExposedTools && scenario.requiresExposedTools.length > 0 && resp.exposedToolNames.length > 0) {
    const missing = scenario.requiresExposedTools.filter(
      (bare) => !resp.exposedToolNames.some((n) => matchBareName(n, bare)),
    );
    if (missing.length > 0) {
      return {
        status: 'skip',
        failures: [],
        skipReasons: [
          `catalog did not expose required tool(s): ${missing.join(', ')}`,
          `setup may have failed — check resp.setup.steps`,
        ],
      };
    }
  }

  // B.1 — HITL pause expectation. When the scenario asserts the agent
  // paused (e.g. for HITL approval), `resp.ok` will be false because the
  // adapter didn't reach a 'completion' event. That's the EXPECTED shape,
  // not a failure — short-circuit success here before the ok-gate below.
  if (scenario.expectsHitlPause) {
    const observed = resp.pauseState?.kind ?? 'none';
    if (observed !== scenario.expectsHitlPause.kind) {
      failures.push(
        `expected pause kind "${scenario.expectsHitlPause.kind}" but observed "${observed}" ` +
        `(reason: ${resp.pauseState?.reason ?? '<none>'})`,
      );
      return { status: 'fail', failures };
    }
    // Pause was observed and matched. Skip ok-gate; assertions on tools /
    // audit / text below still apply because the agent ran up to the pause.
  } else if (!resp.ok) {
    const parts = [
      `outcome=${resp.outcome ?? '<missing>'}`,
      resp.outcomeReason ? `reason=${resp.outcomeReason}` : null,
      resp.error ? `error=${resp.error}` : null,
      resp.httpStatus ? `http=${resp.httpStatus}` : null,
      resp.rawSnippet ? `raw="${resp.rawSnippet}"` : null,
    ].filter(Boolean);
    failures.push(`agent run did not succeed: ${parts.join(' ')}`);
    return { status: 'fail', failures };
  }

  const calledNames = resp.toolCalls.map((c) => c.toolName);

  for (const expected of scenario.expectsTools ?? []) {
    if (!calledNames.some((n) => matchBareName(n, expected))) {
      failures.push(`expected tool "${expected}" was not called (called: ${calledNames.join(', ') || '<none>'})`);
    }
  }

  for (const oneOfSet of scenario.expectsOneOf ?? []) {
    const matched = oneOfSet.some((bare) => calledNames.some((n) => matchBareName(n, bare)));
    if (!matched) {
      failures.push(`expectsOneOf set [${oneOfSet.join(', ')}] — none of those tools were called (called: ${calledNames.join(', ') || '<none>'})`);
    }
  }

  for (const forbidden of scenario.forbidsTools ?? []) {
    if (calledNames.some((n) => matchBareName(n, forbidden))) {
      failures.push(`forbidden tool "${forbidden}" was called`);
    }
  }

  if (scenario.expectsTextIncludes) {
    const needle = scenario.expectsTextIncludes.toLowerCase();
    if (!resp.finalText.toLowerCase().includes(needle)) {
      failures.push(`final text did not include "${scenario.expectsTextIncludes}"`);
    }
  }

  if (scenario.forbidsTextMatching) {
    if (scenario.forbidsTextMatching.test(resp.finalText)) {
      failures.push(`final text matched forbidden pattern ${scenario.forbidsTextMatching}`);
    }
  }

  // B.1 — audit-log content assertions. Run only when the scenario opts in
  // AND the harness surfaced rows. If auditLogs is undefined (older runner
  // / PB without pass-through), record a SKIP-style failure that's clearly
  // distinguishable from a real miss.
  if (scenario.expectsAuditLogContains?.length) {
    if (!resp.auditLogs) {
      failures.push(
        `expectsAuditLogContains set but runner returned no auditLogs field ` +
        `(upgrade TR harness to surface audit_logs, see run-agent-router.ts)`,
      );
    } else {
      for (const expected of scenario.expectsAuditLogContains) {
        const match = resp.auditLogs.find((row) => {
          if (row.action !== expected.action) return false;
          if (expected.errorCodeIncludes) {
            return (row.errorCode ?? '').includes(expected.errorCodeIncludes);
          }
          return true;
        });
        if (!match) {
          const observed = resp.auditLogs.map((r) => `${r.action}${r.errorCode ? `[${r.errorCode}]` : ''}`).join(', ');
          failures.push(
            `expectsAuditLogContains miss for action="${expected.action}"` +
            (expected.errorCodeIncludes ? ` errorCodeIncludes="${expected.errorCodeIncludes}"` : '') +
            ` — observed rows: ${observed || '<none>'}`,
          );
        }
      }
    }
  }

  // B.1 — sanitization regression check. The JSON-stringified, sanitized
  // input_args from audit_logs must NOT match the regex. Use this to assert
  // credential-shaped values were stripped at insert time.
  if (scenario.expectsAuditLogInputArgsNotMatching?.length) {
    if (!resp.auditLogs) {
      failures.push(
        `expectsAuditLogInputArgsNotMatching set but runner returned no auditLogs field`,
      );
    } else {
      for (const check of scenario.expectsAuditLogInputArgsNotMatching) {
        const rows = resp.auditLogs.filter((r) => r.action === check.action);
        if (rows.length === 0) {
          failures.push(
            `expectsAuditLogInputArgsNotMatching: no audit_logs row found for action="${check.action}"`,
          );
          continue;
        }
        for (const row of rows) {
          const serialized = JSON.stringify(row.inputArgs ?? null);
          if (check.mustNotMatch.test(serialized)) {
            failures.push(
              `expectsAuditLogInputArgsNotMatching: action="${check.action}" input_args ` +
              `matched ${check.mustNotMatch} — sanitization failed to redact. Persisted: ${serialized}`,
            );
          }
        }
      }
    }
  }

  return { status: failures.length === 0 ? 'pass' : 'fail', failures };
}
