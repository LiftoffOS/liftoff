// Routines that do mechanical work without paying a model to do it.
//
// Two things carry real risk here and are tested hardest: that script output
// reaches a model as DATA rather than as instructions, and that a routine which
// declares a script never quietly runs without it.

import {
  ROUTINE_SCRIPT_MAX_OUTPUT,
  boundScriptOutput,
  noAgentReply,
  objectiveWithScriptOutput,
  parseRoutineScript,
  runRoutineScript,
} from '../routine-script';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../workspace/untrusted-content-wrapper', () => ({
  frameUntrusted: (source: string, content: string) =>
    `<<UNTRUSTED ${source}>>\n${content}\n<</UNTRUSTED>>`,
}));

describe('reading a script off a routine', () => {
  it('takes an argument array as it is', () => {
    expect(parseRoutineScript(['npm', 'test'])?.args).toEqual(['npm', 'test']);
  });

  it('splits a plain string on whitespace, never through a shell', () => {
    // The distiller writes these from prose, so "run npm test" has to work
    // without teaching anybody JSON — but a value containing a semicolon must
    // not become a second command.
    const s = parseRoutineScript('curl -sf https://example.com/health; rm -rf /');
    expect(s?.args).toEqual(['curl', '-sf', 'https://example.com/health;', 'rm', '-rf', '/']);
  });

  it('accepts the object form with a working directory', () => {
    const s = parseRoutineScript({ args: ['make', 'check'], workDir: 'services/api' });
    expect(s?.args).toEqual(['make', 'check']);
    expect(s?.workDir).toBe('services/api');
  });

  it('carries noAgent through', () => {
    expect(parseRoutineScript('date', true)?.noAgent).toBe(true);
    expect(parseRoutineScript('date')?.noAgent).toBe(false);
  });

  it('is null for a routine with no script', () => {
    expect(parseRoutineScript(undefined)).toBeNull();
    expect(parseRoutineScript(null)).toBeNull();
    expect(parseRoutineScript('   ')).toBeNull();
    expect(parseRoutineScript([])).toBeNull();
    expect(parseRoutineScript({})).toBeNull();
  });

  it('is null for noAgent with nothing to run', () => {
    // A configuration that cannot do anything, refused at read time rather
    // than producing an empty run on every tick forever.
    expect(parseRoutineScript(null, true)).toBeNull();
  });
});

describe('bounding the output', () => {
  it('leaves ordinary output alone', () => {
    expect(boundScriptOutput('all good')).toBe('all good');
  });

  it('truncates a runaway and says so', () => {
    const out = boundScriptOutput('x'.repeat(ROUTINE_SCRIPT_MAX_OUTPUT * 2));
    expect(out.length).toBeLessThan(ROUTINE_SCRIPT_MAX_OUTPUT + 200);
    expect(out).toContain('truncated');
  });
});

describe('running it', () => {
  const base = {
    tenantId: 't1', agentId: 'a1', invocationId: 'inv1', sessionId: 'thread1',
    script: { args: ['npm', 'test'] },
  };

  it('goes to the sandbox, not to this process', async () => {
    // A routine script is customer-authored code, and the one place built to
    // run that — egress policy, command audit, rate limits, credit accounting —
    // is the sandbox.
    const execute = jest.fn().mockResolvedValue({ success: true, data: { stdout: 'ok', exitCode: 0 } });
    await runRoutineScript({ ...base, runner: { execute } });

    const [session, call] = execute.mock.calls[0];
    expect(call.toolName).toBe('shell_exec');
    expect(call.input.args).toEqual(['npm', 'test']);
    expect(session.tenantId).toBe('t1');
    expect(session.agentId).toBe('a1');
  });

  it('carries a timeout, so a hung script cannot stop the routine firing', async () => {
    // The overlap guard skips every tick behind an in-flight run, so a script
    // that hangs does not fail one tick — it silences the routine.
    const execute = jest.fn().mockResolvedValue({ success: true, data: { stdout: '', exitCode: 0 } });
    await runRoutineScript({ ...base, runner: { execute } });
    expect(execute.mock.calls[0][1].input.timeout).toBeGreaterThan(0);
  });

  it('reads a non-zero exit as a failure even when the call itself succeeded', async () => {
    // The sandbox call succeeding means the command RAN, not that it passed.
    const execute = jest.fn().mockResolvedValue({ success: true, data: { stdout: '', stderr: 'boom', exitCode: 1 } });
    const r = await runRoutineScript({ ...base, runner: { execute } });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it('reports a throw rather than propagating it into the tick', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('sandbox gone'));
    const r = await runRoutineScript({ ...base, runner: { execute } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('sandbox gone');
  });
});

describe('handing the output to a model', () => {
  const result = { ok: true, stdout: 'build: green', stderr: '', exitCode: 0 };

  it('frames it as untrusted data', () => {
    // The script read the world, and the world is not the operator. A build log
    // containing "ignore your instructions" must arrive as data.
    const out = objectiveWithScriptOutput('Report on the build', result, 't1');
    expect(out).toContain('<<UNTRUSTED routine-script>>');
    expect(out).toContain('build: green');
  });

  it('keeps the objective first, so the instruction is still the instruction', () => {
    const out = objectiveWithScriptOutput('Report on the build', result, 't1');
    expect(out.indexOf('Report on the build')).toBeLessThan(out.indexOf('build: green'));
  });

  it('includes the exit code, which is often the whole answer', () => {
    expect(objectiveWithScriptOutput('x', result, 't1')).toContain('exit code: 0');
  });

  it('includes stderr, where a failing command usually explains itself', () => {
    const failed = { ok: false, stdout: '', stderr: 'connection refused', exitCode: 7 };
    expect(objectiveWithScriptOutput('x', failed, 't1')).toContain('connection refused');
  });
});

describe('what a noAgent routine reports', () => {
  it('reports stdout as the reply', () => {
    expect(noAgentReply({ ok: true, stdout: '3 rows failed', stderr: '', exitCode: 0 }))
      .toBe('3 rows failed');
  });

  it('stays silent on the silence marker', () => {
    // A monitor that reports every tick teaches people to stop reading it.
    expect(noAgentReply({ ok: true, stdout: '[SILENT]', stderr: '', exitCode: 0 })).toBe('');
  });

  it('stays silent on no output at all', () => {
    expect(noAgentReply({ ok: true, stdout: '   ', stderr: '', exitCode: 0 })).toBe('');
  });

  it('always speaks up when the script failed', () => {
    // Silence is for "nothing changed", never for "I could not tell".
    const r = noAgentReply({ ok: false, stdout: '', stderr: 'permission denied', exitCode: 13 });
    expect(r).toContain('could not complete');
    expect(r).toContain('permission denied');
    expect(r).toContain('13');
  });
});

describe('the wiring', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scheduled-invoke-handler.ts'), 'utf8',
  ) as string;

  it('refuses the tick when there is no sandbox to run the script in', () => {
    // Running the model anyway produces a report about data that was never
    // gathered, which reads exactly like a real report.
    expect(src).toMatch(/routine_script_no_sandbox/);
    expect(src).toMatch(/return res\.status\(200\)\.json\(\{ skipped: true, reason: 'No sandbox for the routine script' \}\)/);
  });

  it('records the refusal as a failure, so the streak guard can see it', () => {
    const idx = src.indexOf('routine_script_no_sandbox');
    expect(src.slice(idx, idx + 700)).toMatch(/recordRoutineOutcome/);
  });

  it('settles a noAgent run through the delivery path routines already use', () => {
    expect(src).toMatch(/settleWakeViaCallback/);
  });

  it('never reaches executeTask on the noAgent path', () => {
    // The whole point: no model runs. A fall-through would make this cost the
    // same as the routine it replaced.
    const noAgentBlock = src.slice(src.indexOf('if (script.noAgent)'), src.indexOf('// A routine may declare that it continues'));
    expect(noAgentBlock).not.toMatch(/executeTask/);
    expect(noAgentBlock).toMatch(/return res\.status\(200\)/);
  });

  it('folds gathered output into the objective on the with-a-model path', () => {
    expect(src).toMatch(/objectiveWithScriptOutput\(objective, scriptResult, payload\.tenantId\)/);
  });
});
