// B1 — the verify-on-stop observation and gate decision.
//
// The whole feature turns on one judgement: did this run change code without
// checking it? Both directions of that judgement are expensive to get wrong. A
// missed nudge leaves an unverified change reported as a success; a spurious
// nudge spends a whole extra turn and teaches people to ignore the signal.

import {
  assessRun,
  buildVerifyContinuation,
  clearRunObservation,
  declineReasonFor,
  exitStatusFromResult,
  looksLikeVerification,
  observedDispatchResult,
  observeToolCall,
  verifyOnStopMode,
  recordWorkspaceFingerprint,
  hasWorkspaceFingerprint,
  markNudged,
  _lastNudgeFingerprintForTest,
  _forgetNudgeForTest,
} from '../verify-on-stop';

let n = 0;
function freshRun(): string {
  return `inv-${++n}`;
}

afterEach(() => {
  delete process.env.VERIFY_ON_STOP_MODE;
});

describe('looksLikeVerification', () => {
  it.each([
    'npm test',
    'npm run lint',
    'pnpm run typecheck',
    'npx jest src/foo.test.ts',
    'npx tsc --noEmit',
    'pytest -q',
    'go test ./...',
    'cargo clippy',
    'make check',
    'bundle exec rspec',
    'cd repo && npm run build',
  ])('recognizes %s', (cmd) => {
    expect(looksLikeVerification(cmd)).toBe(true);
  });

  it.each([
    'echo "tests pass"',
    'git commit -m "add tests"',
    'cat src/test-helpers.ts',
    'ls test/',
  ])('does not mistake %s for verification', (cmd) => {
    // The distinction is running a RUNNER, not mentioning the word. A run that
    // merely says its tests pass must not satisfy the gate.
    expect(looksLikeVerification(cmd)).toBe(false);
  });
});

describe('exitStatusFromResult', () => {
  it('reads an explicit numeric exit code', () => {
    expect(exitStatusFromResult({ exitCode: 0 })).toBe(true);
    expect(exitStatusFromResult({ exitCode: 1 })).toBe(false);
    expect(exitStatusFromResult({ exit_code: 2 })).toBe(false);
  });

  it('treats an error-shaped result as a failure', () => {
    expect(exitStatusFromResult({ isError: true })).toBe(false);
  });

  it('reads an exit code out of the output text', () => {
    expect(exitStatusFromResult({ content: [{ type: 'text', text: 'ok\nexit code: 0' }] })).toBe(true);
    expect(exitStatusFromResult({ content: [{ type: 'text', text: 'FAIL\nexit status 1' }] })).toBe(false);
  });

  it('returns unknown rather than guessing', () => {
    expect(exitStatusFromResult({ content: [{ type: 'text', text: 'some output' }] })).toBeNull();
    expect(exitStatusFromResult(null)).toBeNull();
    expect(exitStatusFromResult(undefined)).toBeNull();
  });
});

describe('observing a run', () => {
  it('records a file written through a write tool', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    expect(assessRun(id).changedPaths).toEqual(['src/app.ts']);
  });

  it('records a file written through the SDK built-in, namespaced or not', () => {
    const id = freshRun();
    observeToolCall(id, 'Edit', { file_path: 'src/a.ts' }, {});
    observeToolCall(id, 'mcp__liftoff-tool-gateway__write_file', { path: 'src/b.ts' }, {});
    expect(assessRun(id).changedPaths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('records a file written through a shell redirect', () => {
    const id = freshRun();
    observeToolCall(id, 'bash', { command: 'echo hi > src/generated.ts' }, { exitCode: 0 });
    expect(assessRun(id).changedPaths).toEqual(['src/generated.ts']);
  });

  it('does not count a prose or asset file as a code change', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'README.md' }, {});
    observeToolCall(id, 'write_file', { path: 'docs/logo.png' }, {});
    const a = assessRun(id);
    expect(a.changedPaths).toEqual([]);
    expect(a.shouldNudge).toBe(false);
  });

  it('counts one path once however many times it is written', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: './src/app.ts' }, {});
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    expect(assessRun(id).changedPaths).toEqual(['src/app.ts']);
  });

  it('records verification with its outcome', () => {
    const id = freshRun();
    observeToolCall(id, 'bash', { command: 'npm test' }, { exitCode: 0 });
    expect(assessRun(id).evidence).toEqual([{ command: 'npm test', passed: true }]);
  });

  it('does not treat a build as a file change just because it wrote artifacts', () => {
    const id = freshRun();
    observeToolCall(id, 'bash', { command: 'npm run build > build.log' }, { exitCode: 0 });
    const a = assessRun(id);
    expect(a.changedPaths).toEqual([]);
    expect(a.evidence).toHaveLength(1);
  });

  it('keeps runs separate', () => {
    const a = freshRun();
    const b = freshRun();
    observeToolCall(a, 'write_file', { path: 'src/a.ts' }, {});
    expect(assessRun(b).changedPaths).toEqual([]);
  });

  it('ignores a call with no invocation id', () => {
    expect(() => observeToolCall(undefined, 'write_file', { path: 'x.ts' }, {})).not.toThrow();
  });

  it('never throws on a malformed call', () => {
    const id = freshRun();
    expect(() => observeToolCall(id, 'bash', undefined, undefined)).not.toThrow();
    expect(() => observeToolCall(id, 'write_file', { path: 42 as unknown as string }, {})).not.toThrow();
  });
});

describe('observing the sandbox registry names (the tools the capability tier exposes)', () => {
  it('records a file written through file_write / file_edit', () => {
    const id = freshRun();
    observeToolCall(id, 'file_write', { path: 'src/a.ts' }, {});
    observeToolCall(id, 'mcp__liftoff-tool-gateway__file_edit', { path: 'src/b.ts' }, {});
    expect(assessRun(id).changedPaths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('records a str_replace edit but never a view', () => {
    const id = freshRun();
    observeToolCall(id, 'file_str_replace_editor', { command: 'view', path: 'src/a.ts' }, {});
    expect(assessRun(id).changedPaths).toEqual([]);
    observeToolCall(id, 'file_str_replace_editor', { command: 'str_replace', path: 'src/a.ts', old_str: 'x', new_str: 'y' }, {});
    expect(assessRun(id).changedPaths).toEqual(['src/a.ts']);
  });

  it('reads a verifier out of shell_exec', () => {
    const id = freshRun();
    observeToolCall(id, 'shell_exec', { command: 'npm test' }, { exitCode: 0 });
    expect(assessRun(id).evidence).toEqual([{ command: 'npm test', passed: true }]);
  });

  it('reads a verifier out of a bash session argv array', () => {
    const id = freshRun();
    observeToolCall(id, 'bash_session_exec', { sessionId: 's1', args: ['npm', 'test'] }, { exitCode: 0 });
    expect(assessRun(id).evidence).toEqual([{ command: 'npm test', passed: true }]);
  });

  it('reads a verifier out of code_execute only when the language is bash', () => {
    const id = freshRun();
    observeToolCall(id, 'code_execute', { language: 'bash', code: 'npx tsc --noEmit' }, { exitCode: 0 });
    observeToolCall(id, 'code_execute', { language: 'python', code: 'print("npm test")' }, { exitCode: 0 });
    expect(assessRun(id).evidence).toEqual([{ command: 'npx tsc --noEmit', passed: true }]);
  });

  it('scrapes a shell_exec write like any other shell', () => {
    const id = freshRun();
    observeToolCall(id, 'shell_exec', { command: 'echo hi > src/gen.ts' }, { exitCode: 0 });
    expect(assessRun(id).changedPaths).toEqual(['src/gen.ts']);
  });
});

describe('observedDispatchResult (gateway seam shaping)', () => {
  it("passes through a result carrying the tool's own exit info — it wins over the flag", () => {
    // Gateway says success, the command inside failed: the command's truth wins.
    expect(exitStatusFromResult(observedDispatchResult(true, { exitCode: 1 }))).toBe(false);
    expect(exitStatusFromResult(observedDispatchResult(true, 'FAIL\nexit code: 1'))).toBe(false);
    expect(exitStatusFromResult(observedDispatchResult(false, { exitCode: 0 }))).toBe(true);
  });

  it('falls back to the gateway flag when the result has no exit signal', () => {
    expect(exitStatusFromResult(observedDispatchResult(true, 'some output'))).toBe(true);
    expect(exitStatusFromResult(observedDispatchResult(false, 'some output'))).toBe(false);
    expect(exitStatusFromResult(observedDispatchResult(true, { rows: [1, 2] }))).toBe(true);
  });

  it('composes with observation end-to-end', () => {
    const id = freshRun();
    observeToolCall(id, 'file_write', { path: 'src/app.ts' }, observedDispatchResult(true, { ok: true }));
    observeToolCall(id, 'shell_exec', { command: 'npm test' }, observedDispatchResult(true, { exitCode: 1, stdout: '2 failed' }));
    // The dispatch succeeded but the tests failed — must still nudge.
    expect(assessRun(id).shouldNudge).toBe(true);
  });
});

describe('observing a code_session result', () => {
  // The tool returns JSON.stringify(CodeSessionOutput) inside an MCP content
  // array — exactly what the observation seams see. On the Anthropic engine
  // the OUTER agent has no file/shell tools, so this result is the only
  // window into what a run changed.
  function codeSessionResult(output: Record<string, unknown>) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
  }

  it('records the files the inner session modified', () => {
    const id = freshRun();
    observeToolCall(id, 'code_session', { task: 'fix the bug' }, codeSessionResult({
      files_modified: ['src/app.ts', './src/util.ts'],
      tool_calls_made: [],
      exit_reason: 'success',
    }));
    expect(assessRun(id).changedPaths.sort()).toEqual(['src/app.ts', 'src/util.ts']);
  });

  it('applies the prose filter to inner files too', () => {
    const id = freshRun();
    observeToolCall(id, 'code_session', {}, codeSessionResult({
      files_modified: ['README.md', 'docs/shot.png'],
      exit_reason: 'success',
    }));
    expect(assessRun(id).shouldNudge).toBe(false);
  });

  it('counts an inner passing verifier as evidence', () => {
    const id = freshRun();
    observeToolCall(id, 'code_session', {}, codeSessionResult({
      files_modified: ['src/app.ts'],
      tool_calls_made: [
        { tool: 'Bash', args: { command: 'npm test' }, result: 'all green\nexit code: 0' },
      ],
      exit_reason: 'success',
    }));
    const a = assessRun(id);
    expect(a.evidence).toEqual([{ command: 'npm test', passed: true }]);
    expect(a.shouldNudge).toBe(false);
  });

  it('counts an inner verifier with unreadable status as an attempt, not a failure', () => {
    const id = freshRun();
    observeToolCall(id, 'code_session', {}, codeSessionResult({
      files_modified: ['src/app.ts'],
      tool_calls_made: [{ tool: 'Bash', args: { command: 'npx jest' }, result: 'ran 42 tests' }],
      exit_reason: 'success',
    }));
    expect(assessRun(id).shouldNudge).toBe(false);
  });

  it('never counts a verifier from a failed or timed-out session as passing', () => {
    const id = freshRun();
    observeToolCall(id, 'code_session', {}, codeSessionResult({
      files_modified: ['src/app.ts'],
      tool_calls_made: [
        { tool: 'Bash', args: { command: 'npm test' }, result: 'exit code: 0' },
      ],
      exit_reason: 'timeout',
    }));
    const a = assessRun(id);
    expect(a.evidence).toEqual([{ command: 'npm test', passed: false }]);
    expect(a.shouldNudge).toBe(true);
  });

  it('nudges a session that changed code and never verified', () => {
    const id = freshRun();
    observeToolCall(id, 'mcp__liftoff-tool-gateway__code_session', {}, codeSessionResult({
      files_modified: ['src/app.ts'],
      tool_calls_made: [{ tool: 'Edit', args: { file_path: 'src/app.ts' }, result: 'ok' }],
      exit_reason: 'success',
    }));
    expect(assessRun(id).shouldNudge).toBe(true);
  });

  it('observes nothing rather than guessing on a malformed result', () => {
    const id = freshRun();
    expect(() => observeToolCall(id, 'code_session', {}, { content: [{ type: 'text', text: 'not json' }] })).not.toThrow();
    expect(() => observeToolCall(id, 'code_session', {}, codeSessionResult({ files_modified: 'nope' as unknown as string[] }))).not.toThrow();
    expect(assessRun(id).changedPaths).toEqual([]);
  });
});

describe('observing executeToolCalls-shaped dispatches', () => {
  // The gateway seam constructs { isError, exitCode, output } from
  // ToolCallResult.success — success maps to exit 0, failure to isError.
  it('reads a passing verifier from the constructed success shape', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, { isError: false, exitCode: 0, output: '' });
    observeToolCall(id, 'run_shell', { command: 'npm test' }, { isError: false, exitCode: 0, output: 'ok' });
    expect(assessRun(id).shouldNudge).toBe(false);
  });

  it('reads a failed verifier from the constructed failure shape', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, { isError: false, exitCode: 0, output: '' });
    observeToolCall(id, 'run_shell', { command: 'npm test' }, { isError: true, exitCode: 1, output: '2 failed' });
    expect(assessRun(id).shouldNudge).toBe(true);
  });
});

describe('declineReasonFor', () => {
  it('says no_code_change when nothing code-shaped changed', () => {
    const id = freshRun();
    observeToolCall(id, 'bash', { command: 'ls' }, { exitCode: 0 });
    expect(declineReasonFor(assessRun(id), hasWorkspaceFingerprint(id))).toBe('unobserved');
  });

  it('says verified when a change had evidence', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    observeToolCall(id, 'bash', { command: 'npm test' }, { exitCode: 0 });
    expect(declineReasonFor(assessRun(id))).toBe('verified');
  });
});

describe('the gate decision', () => {
  it('nudges a run that changed code and verified nothing', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    expect(assessRun(id).shouldNudge).toBe(true);
  });

  it('stays quiet when a verifier passed', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    observeToolCall(id, 'bash', { command: 'npm test' }, { exitCode: 0 });
    expect(assessRun(id).shouldNudge).toBe(false);
  });

  it('nudges when the only verifier failed', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    observeToolCall(id, 'bash', { command: 'npm test' }, { exitCode: 1 });
    // A failing test run is not verification of a change — it is the opposite.
    expect(assessRun(id).shouldNudge).toBe(true);
  });

  it('stays quiet when a verifier ran but its status was unreadable', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    observeToolCall(id, 'bash', { command: 'npm test' }, { content: [{ type: 'text', text: 'output' }] });
    // Nudging a run that plainly tried is worse than staying quiet about one
    // whose exit code we simply could not parse.
    expect(assessRun(id).shouldNudge).toBe(false);
  });

  it('stays quiet for a run that changed nothing', () => {
    const id = freshRun();
    observeToolCall(id, 'bash', { command: 'ls src/' }, { exitCode: 0 });
    expect(assessRun(id).shouldNudge).toBe(false);
  });

  it('stays quiet for a run it never observed', () => {
    expect(assessRun('never-seen').shouldNudge).toBe(false);
    expect(assessRun(undefined).shouldNudge).toBe(false);
  });

  it('forgets a run once it is cleared', () => {
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    clearRunObservation(id);
    expect(assessRun(id).changedPaths).toEqual([]);
  });
});

describe('the mode flag', () => {
  it('is off unless something says otherwise', () => {
    expect(verifyOnStopMode()).toBe('off');
  });

  it('reads shadow and enforce', () => {
    process.env.VERIFY_ON_STOP_MODE = 'shadow';
    expect(verifyOnStopMode()).toBe('shadow');
    process.env.VERIFY_ON_STOP_MODE = 'ENFORCE';
    expect(verifyOnStopMode()).toBe('enforce');
  });

  it('treats an unrecognized value as off, never as enforce', () => {
    process.env.VERIFY_ON_STOP_MODE = 'yes-please';
    expect(verifyOnStopMode()).toBe('off');
  });
});

describe('the continuation message', () => {
  const assessment = {
    changedPaths: ['src/a.ts', 'src/b.ts'],
    evidence: [] as Array<{ command: string; passed: boolean | null }>,
    shouldNudge: true,
  };

  it('names the files it is asking about', () => {
    const msg = buildVerifyContinuation(assessment);
    expect(msg).toContain('src/a.ts');
    expect(msg).toContain('src/b.ts');
  });

  it('allows "I cannot" as an answer', () => {
    expect(buildVerifyContinuation(assessment)).toMatch(/cannot run them/i);
  });

  it('forbids claiming a suite passed without running it', () => {
    const msg = buildVerifyContinuation(assessment);
    expect(msg).toMatch(/unless you ran it and saw it pass/i);
    expect(msg).toMatch(/targeted run/i);
  });

  it('says what was already attempted, when something was', () => {
    const msg = buildVerifyContinuation({
      ...assessment,
      evidence: [{ command: 'npm test', passed: false }],
    });
    expect(msg).toContain('npm test');
    expect(msg).toMatch(/did not pass/i);
  });

  it('does not list every file when there are many', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const msg = buildVerifyContinuation({ ...assessment, changedPaths: many });
    expect(msg).toContain('and 20 more');
  });
});

describe('the shadow mode can be reviewed at all', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('records every ELIGIBLE run, not only the ones that trip', () => {
    // The rollout gate is "review the shadow rate". A mode that logs only when
    // it fires cannot produce a rate: ninety days of silence reads identically
    // as "every run verified its work" and "the gate is dead". The denominator
    // is what makes those two distinguishable.
    expect(src).toMatch(/event: 'verify_on_stop_eligible'/);
  });

  it('records the eligibility BEFORE the shouldNudge branch', () => {
    // After it, the denominator would only ever count runs that tripped, which
    // is the numerator again.
    const gate = src.slice(src.indexOf('private async decideVerifyOnStop'));
    expect(gate.indexOf("event: 'verify_on_stop_eligible'"))
      .toBeLessThan(gate.indexOf('if (!assessment.shouldNudge) return decline()'));
  });

  it('records in every mode, not only shadow', () => {
    // The rate stops being measurable the moment the gate is turned on, which
    // is when it matters most.
    const gate = src.slice(src.indexOf('private async decideVerifyOnStop'));
    const line = gate.slice(gate.indexOf("event: 'verify_on_stop_eligible'") - 400,
      gate.indexOf("event: 'verify_on_stop_eligible'"));
    expect(line).not.toMatch(/if \(mode === 'shadow'\)/);
  });

  it('still says WHY it declined, which is the other half of the picture', () => {
    // A gate that declines everything and a fleet that verifies everything are
    // otherwise indistinguishable.
    expect(src).toMatch(/declineReason: assessment\.shouldNudge/);
    expect(src).toMatch(/declineReasonFor\(assessment, fingerprinted\)/);
    // And it distinguishes "the workspace did not move" from "nobody looked".
    // Recording the second as the first claims the run did nothing, which is a
    // claim the data does not support.
    expect(src).toMatch(/workspaceObserved: fingerprinted/);
    expect(src).toMatch(/workspaceMoved: assessment\.workspaceMoved/);
  });

  it('carries whether it would have nudged, so one query gives both numbers', () => {
    expect(src).toMatch(/wouldNudge: assessment\.shouldNudge/);
  });
});

// ── The workspace fingerprint ───────────────────────────────────────────────
//
// The allow-list answers WHICH paths changed by recognising tool names and
// scraping shell commands, so it is blind to every write that goes through a
// path nobody enumerated. The fingerprint answers the narrower question — did
// the workspace move — for every write, whatever made it.
describe('workspace-derived change detection', () => {
  const fresh = () => `fp-${Math.random().toString(36).slice(2)}`;

  it('reports the workspace as unmoved when no fingerprint was taken', () => {
    const id = fresh();
    observeToolCall(id, 'bash', { command: 'ls' }, { exitCode: 0 });
    expect(assessRun(id).workspaceMoved).toBe(false);
  });

  it('reports a moved workspace when the fingerprint changed', () => {
    const id = fresh();
    observeToolCall(id, 'bash', { command: 'ls' }, { exitCode: 0 });
    recordWorkspaceFingerprint(id, 'tree-a');
    recordWorkspaceFingerprint(id, 'tree-b');
    expect(assessRun(id).workspaceMoved).toBe(true);
  });

  it('reports an unmoved workspace when the fingerprint is unchanged', () => {
    const id = fresh();
    recordWorkspaceFingerprint(id, 'tree-a');
    recordWorkspaceFingerprint(id, 'tree-a');
    expect(assessRun(id).workspaceMoved).toBe(false);
  });

  // The case the whole change exists for: a fetch-transform-write run whose
  // writes go through `curl -o`, which matches no tool name and no redirect.
  it('nudges a run that wrote through a path the allow-list cannot see', () => {
    const id = fresh();
    observeToolCall(id, 'bash', { command: 'curl -o data.json https://example.com' }, { exitCode: 0 });
    recordWorkspaceFingerprint(id, 'tree-before');
    recordWorkspaceFingerprint(id, 'tree-after');
    const a = assessRun(id);
    expect(a.changedPaths).toEqual([]);
    expect(a.workspaceMoved).toBe(true);
    expect(a.shouldNudge).toBe(true);
  });

  it('still does not nudge when the run verified', () => {
    const id = fresh();
    recordWorkspaceFingerprint(id, 'tree-before');
    observeToolCall(id, 'bash', { command: 'npm test' }, { exitCode: 0 });
    recordWorkspaceFingerprint(id, 'tree-after');
    expect(assessRun(id).shouldNudge).toBe(false);
  });

  // One missing reading means "we could not tell", which must never become
  // "nothing changed" — that would suppress a nudge the run had earned.
  it('does not treat a single reading as evidence either way', () => {
    const id = fresh();
    recordWorkspaceFingerprint(id, 'tree-only');
    expect(assessRun(id).workspaceMoved).toBe(false);
    expect(hasWorkspaceFingerprint(id)).toBe(true);
  });

  it('accepts caller-supplied fingerprints over the observed ones', () => {
    const id = fresh();
    recordWorkspaceFingerprint(id, 'tree-a');
    recordWorkspaceFingerprint(id, 'tree-a');
    expect(assessRun(id, { atStart: 'x', atStop: 'y' }).workspaceMoved).toBe(true);
  });
});

describe('the second-nudge bound', () => {
  const fresh = () => `nudge-${Math.random().toString(36).slice(2)}`;

  // Nudging an unchanged workspace asks the run to verify the state it was
  // already asked about, which is how a one-shot check becomes a loop.
  it('suppresses a second nudge when the workspace has not moved', () => {
    const id = fresh();
    observeToolCall(id, 'file_write', { path: 'src/a.ts' }, { exitCode: 0 });
    recordWorkspaceFingerprint(id, 'tree-a');
    expect(assessRun(id).shouldNudge).toBe(true);
    markNudged(id);
    expect(assessRun(id).shouldNudge).toBe(false);
    _forgetNudgeForTest(id);
  });

  it('allows a second nudge once the workspace moves again', () => {
    const id = fresh();
    observeToolCall(id, 'file_write', { path: 'src/a.ts' }, { exitCode: 0 });
    recordWorkspaceFingerprint(id, 'tree-a');
    markNudged(id);
    expect(assessRun(id).shouldNudge).toBe(false);
    recordWorkspaceFingerprint(id, 'tree-b');
    expect(assessRun(id).shouldNudge).toBe(true);
    _forgetNudgeForTest(id);
  });

  // "Nudged and could not read the workspace" must still suppress a second
  // identical nudge, or an unfingerprintable run is nudged on every finalize.
  it('suppresses a repeat nudge on a run that could not be fingerprinted', () => {
    const id = fresh();
    observeToolCall(id, 'file_write', { path: 'src/a.ts' }, { exitCode: 0 });
    expect(assessRun(id).shouldNudge).toBe(true);
    markNudged(id);
    expect(assessRun(id).shouldNudge).toBe(false);
    _forgetNudgeForTest(id);
  });

  it('survives the observation being cleared, which is what it is for', () => {
    const id = fresh();
    observeToolCall(id, 'file_write', { path: 'src/a.ts' }, { exitCode: 0 });
    recordWorkspaceFingerprint(id, 'tree-a');
    markNudged(id);
    clearRunObservation(id);
    expect(_lastNudgeFingerprintForTest(id)).toBe('tree-a');
    _forgetNudgeForTest(id);
  });
});

describe('declineReasonFor', () => {
  it('says unobserved when nothing changed AND nobody looked', () => {
    const a = { changedPaths: [], workspaceMoved: false, evidence: [], shouldNudge: false };
    expect(declineReasonFor(a, false)).toBe('unobserved');
  });

  it('says no_code_change when nothing changed and the workspace WAS read', () => {
    const a = { changedPaths: [], workspaceMoved: false, evidence: [], shouldNudge: false };
    expect(declineReasonFor(a, true)).toBe('no_code_change');
  });

  it('says verified when something changed', () => {
    const a = { changedPaths: ['src/a.ts'], workspaceMoved: false, evidence: [], shouldNudge: false };
    expect(declineReasonFor(a, true)).toBe('verified');
  });

  it('says verified when only the workspace moved', () => {
    const a = { changedPaths: [], workspaceMoved: true, evidence: [], shouldNudge: false };
    expect(declineReasonFor(a, true)).toBe('verified');
  });
});
