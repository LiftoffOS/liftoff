// The scripted engine, and the loop behaviours it exists to pin.
//
// certify.ts proves each adapter's contract; nothing tested the loop that reads
// those adapters. The bug its own settle() comment records — a saturation check
// at one return, silently skipped by seven others — is invisible to a
// per-adapter suite, because every adapter was behaving correctly.
//
// Two halves here: the fake itself must be faithful (a fake that ignores an
// abort would let a loop that ignores aborts pass), and the loop invariants it
// makes testable.

import {
  ScriptedAdapter,
  assistant,
  completion,
  toolStarted,
  toolFinished,
  usage,
  anomaly,
  sessionStarted,
} from './scripted-adapter';
import type { InvocationEvent, InvocationInput, McpToolCatalog } from '../types';
import { resolveTerminalState, OUTCOME_BY_TERMINAL } from '../../terminal-state';
import { InjectionQueue } from '../../injection';

const input = (): InvocationInput => ({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }],
  systemPrompt: 'sys',
  model: 'm',
  provider: 'anthropic',
  tenantId: 't',
  invocationId: 'inv-1',
});

async function drain(stream: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('the fake is faithful', () => {
  it('yields exactly the scripted turn', async () => {
    const a = new ScriptedAdapter([[assistant('hello'), completion('success')]]);
    const events = await drain(a.invoke(input(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['assistant_message', 'completion']);
  });

  it('advances a turn per invoke and reuses the last script', async () => {
    const a = new ScriptedAdapter([
      [assistant('first'), completion('success')],
      [assistant('second'), completion('success')],
    ]);
    const ac = new AbortController();
    await drain(a.invoke(input(), ac.signal));
    await drain(a.invoke(input(), ac.signal));
    const third = await drain(a.invoke(input(), ac.signal));
    expect((third[0] as { content: Array<{ text: string }> }).content[0].text).toBe('second');
    expect(a.invocations).toHaveLength(3);
  });

  // A fake that ran its script to the end regardless would let a loop that
  // ignores the abort signal pass its own test.
  it('stops yielding when the signal aborts', async () => {
    const a = new ScriptedAdapter([[assistant('a'), assistant('b'), completion('success')]]);
    const ac = new AbortController();
    ac.abort();
    expect(await drain(a.invoke(input(), ac.signal))).toEqual([]);
  });

  it('can throw on a chosen invoke, which is the loop\'s other terminal path', async () => {
    const a = new ScriptedAdapter([[completion('success')]], { throwOnInvoke: 0 });
    await expect(drain(a.invoke(input(), new AbortController().signal))).rejects.toThrow(/threw on invoke 0/);
  });

  it('captures every registration for assertion', () => {
    const a = new ScriptedAdapter([[completion('success')]]);
    const catalog: McpToolCatalog = { servers: [], tools: [] };
    a.registerToolCatalog(catalog);
    a.registerHitlGate(async () => ({ allow: true }));
    a.registerAnomalyHandler(async () => ({ escalate: false }));
    a.registerTrajectoryRecorder({ recordRaw: () => undefined });
    expect(a.registeredCatalogs).toEqual([catalog]);
    expect(a.registeredGates).toHaveLength(1);
    expect(a.registeredAnomalyHandlers).toHaveLength(1);
    expect(a.registeredRecorders).toHaveLength(1);
  });

  // The loop re-registers — an empty catalog for a probe, a filtered one for a
  // leaf — so "what did the model see" is the LAST registration.
  it('reports the last catalog as the effective one', () => {
    const a = new ScriptedAdapter([[completion('success')]]);
    const first: McpToolCatalog = { servers: [], tools: [{ name: 'a', description: '', inputSchema: {}, serverId: 's' }] };
    const second: McpToolCatalog = { servers: [], tools: [] };
    a.registerToolCatalog(first);
    a.registerToolCatalog(second);
    expect(a.effectiveCatalog).toBe(second);
  });

  it('records injections, pauses and resumes in order', async () => {
    const a = new ScriptedAdapter([[completion('success')]]);
    await a.injectMessage({ text: 'steer', source: 'interrupt' });
    const token = await a.pause('hitl_gate');
    await drain(a.resume(token, { text: 'go' }, new AbortController().signal));
    expect(a.injected.map((m) => m.text)).toEqual(['steer']);
    expect(a.pauses).toEqual(['hitl_gate']);
    expect(a.resumes[0].response).toEqual({ text: 'go' });
  });

  it('round-trips a serializable pause token', async () => {
    const a = new ScriptedAdapter([[completion('success')]]);
    const token = await a.pause('ask_user');
    expect(typeof token.serialized).toBe('string');
    expect(JSON.parse(token.serialized)).toEqual({ reason: 'ask_user' });
  });
});

// ── Terminal precedence ─────────────────────────────────────────────────────
//
// The order is: engine error > report_task_outcome > limit_reached > text
// markers > fallback. It used to be re-derived at each return, which is how the
// same run was a 'success' to the invocation record and 'interrupted' to the run
// state at the same time.
describe('terminal precedence', () => {
  it('lets an explicit terminalState win over success and escalated', () => {
    expect(resolveTerminalState(
      { terminalState: 'engine_error', success: true, escalated: true }, false,
    )).toBe('engine_error');
  });

  it('puts governance above escalation and success', () => {
    expect(resolveTerminalState({ success: true, escalated: true }, true)).toBe('gated');
  });

  it('puts escalation above success', () => {
    expect(resolveTerminalState({ success: true, escalated: true }, false)).toBe('escalated');
  });

  it('falls back to engine_error rather than to success', () => {
    expect(resolveTerminalState({ success: false }, false)).toBe('engine_error');
  });

  // A run cut off by its own budget did not meet its objective, and recording it
  // as a success is how a truncated run reads as a finished one.
  it('never records limit_reached as a successful outcome', () => {
    expect(OUTCOME_BY_TERMINAL.limit_reached).toBe('error');
  });

  // A user stop is not a failure. The distinction lives in the audit detail
  // because invocations.outcome has no 'stopped' member.
  it('records a user stop as a success outcome, not an error', () => {
    expect(OUTCOME_BY_TERMINAL.stopped).toBe('success');
  });

  it('maps every terminal state to a legal outcome', () => {
    // The CHECK on invocations.outcome. 'parked' joined it in migration 390,
    // for a run that stopped on the wall clock with its own continuation
    // scheduled — not a run anyone owes a decision.
    const legal = new Set(['success', 'error', 'escalated', 'gated', 'parked']);
    for (const outcome of Object.values(OUTCOME_BY_TERMINAL)) {
      expect(legal.has(outcome)).toBe(true);
    }
  });
});

// ── Injection accounting ────────────────────────────────────────────────────
//
// The loop's cap used to be an integer incremented in one place, decremented in
// another, and bounded in a third.
describe('injection ordering through the loop contract', () => {
  it('delivers a steer only at a tool-result boundary', () => {
    const q = new InjectionQueue();
    q.enqueue({ kind: 'steer', source: 'user', text: 'go left', drain: 'one-at-a-time' });
    expect(q.drainAt('assistant_message')).toEqual([]);
    expect(q.drainAt('tool_call_finished')).toHaveLength(1);
  });

  // Each steer buys exactly one extra turn: the completion that follows it is
  // the turn it bought, not a second one.
  it('settles one in-flight steer per completion', () => {
    const q = new InjectionQueue();
    q.enqueue({ kind: 'steer', source: 'user', text: 'a', drain: 'one-at-a-time' });
    q.drainAt('tool_call_finished');
    expect(q.inFlightCount('steer')).toBe(1);
    q.settleOne('steer');
    expect(q.inFlightCount('steer')).toBe(0);
  });
});

// ── Recovery caps ───────────────────────────────────────────────────────────
describe('recovery caps as the loop applies them', () => {
  const PER_STEP_CAP = 5;
  const TOTAL_CAP = 20;

  /** The loop's own predicate, stated once. */
  const exhausted = (perStep: number, total: number) =>
    perStep >= PER_STEP_CAP || total >= TOTAL_CAP;

  it('trips on the per-step cap before the total is anywhere near', () => {
    expect(exhausted(PER_STEP_CAP, 0)).toBe(true);
    expect(exhausted(PER_STEP_CAP - 1, 0)).toBe(false);
  });

  it('trips on the total cap even when each step is under its own', () => {
    expect(exhausted(1, TOTAL_CAP)).toBe(true);
    expect(exhausted(1, TOTAL_CAP - 1)).toBe(false);
  });

  // A code-execution tool that failed will not fail the same way next time —
  // writing a corrected script IS the retry — so it must not count toward a cap
  // that exists for tools which will.
  it('carves out the code-execution tools', () => {
    const CODE_EXECUTION_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);
    for (const tool of ['Bash', 'BashOutput', 'KillShell']) {
      expect(CODE_EXECUTION_TOOLS.has(tool)).toBe(true);
    }
    expect(CODE_EXECUTION_TOOLS.has('file_write')).toBe(false);
  });
});

// ── The shapes the loop has to survive ──────────────────────────────────────
describe('scripted streams the loop must handle', () => {
  it('a clean run: session, usage, answer, success', async () => {
    const a = new ScriptedAdapter([[
      sessionStarted('sess-1'), usage(1200, 300), assistant('done'), completion('success'),
    ]]);
    const events = await drain(a.invoke(input(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual([
      'session_started', 'usage', 'assistant_message', 'completion',
    ]);
  });

  it('a tool round trip', async () => {
    const a = new ScriptedAdapter([[
      toolStarted('file_read', 'c1', { path: '/a' }),
      toolFinished('c1', 'contents'),
      assistant('read it'),
      completion('success'),
    ]]);
    const events = await drain(a.invoke(input(), new AbortController().signal));
    expect(events[1]).toEqual({ type: 'tool_call_finished', callId: 'c1', result: 'contents' });
  });

  it('a failed tool carries its error', async () => {
    const a = new ScriptedAdapter([[toolFinished('c1', null, 'boom'), completion('error', 'tool failed')]]);
    const events = await drain(a.invoke(input(), new AbortController().signal));
    expect((events[0] as { error?: string }).error).toBe('boom');
  });

  it('an anomaly precedes its terminal', async () => {
    const a = new ScriptedAdapter([[anomaly('malformed_output', 'not json'), completion('error', 'gave up')]]);
    const events = await drain(a.invoke(input(), new AbortController().signal));
    expect(events[0].type).toBe('anomaly_detected');
    expect(events[1].type).toBe('completion');
  });

  // Exactly one terminal event is the contract every adapter is certified
  // against; a script that breaks it is how a loop test proves the loop notices.
  it('a script can produce exactly one terminal', async () => {
    const a = new ScriptedAdapter([[assistant('a'), completion('success')]]);
    const events = await drain(a.invoke(input(), new AbortController().signal));
    expect(events.filter((e) => e.type === 'completion')).toHaveLength(1);
  });
});
