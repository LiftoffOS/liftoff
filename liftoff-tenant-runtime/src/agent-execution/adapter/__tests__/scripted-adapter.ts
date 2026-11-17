// An engine that does exactly what the test says.
//
// `certification/certify.ts` proves each adapter's CONTRACT. Nothing tests
// `runConversationalTurnsViaAdapter` itself — the loop that decides what a run
// means. Its own `settle()` comment records the bug a test would have caught:
//
//   "The saturation check used to sit at one return, which meant the other
//    seven — the pre-loop context-pressure escalation, the recovery advisor's
//    terminal decision, a user stop, the same two again on the throw path, the
//    injected-turn reply, and the error result — silently skipped it."
//
// Seven paths, each one a place where the loop's own accounting quietly did not
// happen. That class of defect is invisible to a per-adapter suite, because
// every adapter was behaving correctly.
//
// This is the engine those tests need: a VendorSdkAdapter whose output is a
// script rather than a model. One array of events per invoke() call, so a test
// can say "first turn does this, then the loop should…" and assert the answer.
// It also captures every registration so the ordering questions — was the
// catalog registered before invoke, did the gate see this call — become
// assertions rather than assumptions.

import type {
  AnomalyHandler,
  HitlGate,
  InvocationEvent,
  InvocationInput,
  McpToolCatalog,
  PauseReason,
  ResumeToken,
  TrajectoryRecorder,
  UserMessage,
  UserResponse,
  VendorSdkAdapter,
} from '../types';

export interface ScriptedAdapterOptions {
  /** Reported to the loop. Controls whether the context-pressure NUDGE is
   *  applied — measurement happens either way. */
  managesOwnContext?: boolean;
  /** Events for resume(), if the test drives one. Falls back to a single
   *  success completion. */
  resumeScript?: InvocationEvent[];
  /** Throw instead of yielding, on the Nth invoke (0-based). Exercises the
   *  loop's throw path, which is where four of the seven skipped returns were. */
  throwOnInvoke?: number;
}

export class ScriptedAdapter implements VendorSdkAdapter {
  readonly kind = 'scripted';
  readonly managesOwnContext: boolean;

  /** Every catalog, gate, handler and recorder the loop registered. Kept so a
   *  test can assert WHAT was registered and in what order, rather than assuming
   *  the loop wired what it was supposed to. */
  readonly registeredCatalogs: McpToolCatalog[] = [];
  readonly registeredGates: HitlGate[] = [];
  readonly registeredAnomalyHandlers: AnomalyHandler[] = [];
  readonly registeredRecorders: TrajectoryRecorder[] = [];

  /** Every invoke() the loop made, with the input it made it with. The count is
   *  itself an assertion: the loop is a single invoke that runs many turns, so a
   *  test expecting two invokes is testing a re-entry. */
  readonly invocations: InvocationInput[] = [];
  /** Messages injected mid-run, in order. */
  readonly injected: UserMessage[] = [];
  readonly pauses: PauseReason[] = [];
  readonly resumes: Array<{ token: ResumeToken; response: UserResponse }> = [];

  private invokeCount = 0;

  /** One array per invoke() call. A script shorter than the number of invokes
   *  reuses its last turn, so a test that only cares about the first turn does
   *  not have to enumerate the rest. */
  constructor(
    private readonly script: InvocationEvent[][],
    private readonly opts: ScriptedAdapterOptions = {},
  ) {
    this.managesOwnContext = opts.managesOwnContext ?? false;
  }

  async *invoke(input: InvocationInput, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    const turn = this.invokeCount++;
    this.invocations.push(input);
    if (this.opts.throwOnInvoke === turn) {
      throw new Error(`scripted adapter threw on invoke ${turn}`);
    }
    const events = this.script[Math.min(turn, this.script.length - 1)] ?? [];
    for (const event of events) {
      // Honour the abort the way a real adapter does: stop yielding rather than
      // running the script to its end. A loop that ignores the signal must fail
      // its own test, not be rescued by the fake.
      if (signal.aborted) return;
      yield event;
    }
  }

  async *resume(
    token: ResumeToken,
    response: UserResponse,
    signal: AbortSignal,
  ): AsyncIterable<InvocationEvent> {
    this.resumes.push({ token, response });
    const events = this.opts.resumeScript ?? [{ type: 'completion', outcome: 'success' } as InvocationEvent];
    for (const event of events) {
      if (signal.aborted) return;
      yield event;
    }
  }

  async injectMessage(message: UserMessage): Promise<void> {
    this.injected.push(message);
  }

  async pause(reason: PauseReason): Promise<ResumeToken> {
    this.pauses.push(reason);
    return { adapterKind: this.kind, serialized: JSON.stringify({ reason }) };
  }

  registerToolCatalog(catalog: McpToolCatalog): void {
    this.registeredCatalogs.push(catalog);
  }

  registerHitlGate(gate: HitlGate): void {
    this.registeredGates.push(gate);
  }

  registerAnomalyHandler(handler: AnomalyHandler): void {
    this.registeredAnomalyHandlers.push(handler);
  }

  registerTrajectoryRecorder(recorder: TrajectoryRecorder): void {
    this.registeredRecorders.push(recorder);
  }

  /** The catalog the model actually saw on the LAST registration. The loop
   *  re-registers (an empty catalog for a probe, a filtered one for a leaf), so
   *  "what did the model see" is the last one, not the first. */
  get effectiveCatalog(): McpToolCatalog | undefined {
    return this.registeredCatalogs[this.registeredCatalogs.length - 1];
  }
}

// ── Event constructors ──────────────────────────────────────────────────────
//
// Named so a script reads as a sequence of things that happened rather than as
// object literals. A test that says `[assistant('done'), completion('success')]`
// states its premise in one line.

export const assistant = (text: string): InvocationEvent =>
  ({ type: 'assistant_message', content: [{ type: 'text', text }] });

export const toolStarted = (toolName: string, callId: string, args: unknown = {}): InvocationEvent =>
  ({ type: 'tool_call_started', toolName, args, callId });

export const toolFinished = (callId: string, result: unknown, error?: string): InvocationEvent =>
  ({ type: 'tool_call_finished', callId, result, ...(error ? { error } : {}) });

export const usage = (inputTokens: number, outputTokens = 0, cachedTokens = 0): InvocationEvent =>
  ({ type: 'usage', usage: { inputTokens, outputTokens, cachedTokens } });

export const completion = (
  outcome: 'success' | 'error' | 'escalated' | 'limit_reached',
  reason?: string,
): InvocationEvent => ({ type: 'completion', outcome, ...(reason ? { reason } : {}) });

export const anomaly = (kind: string, error: string): InvocationEvent =>
  ({ type: 'anomaly_detected', kind: kind as never, context: { error } });

export const sessionStarted = (sessionId: string): InvocationEvent =>
  ({ type: 'session_started', sessionId });
