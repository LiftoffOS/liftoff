// The audit rows ONE invocation writes must agree with each other.
//
// A run writes `agent_invocation_started` at the top and a terminal
// `agent_execution` at the bottom, on both the success path and the
// error-salvage catch. The start row computed a conforming triggeredBy while
// the terminal rows passed the raw four-value enum, so the outbox coerced
// 'human' → human:unknown and 'event' → event:unknown and the two rows for one
// invocation_id disagreed. The value semantics are pinned by
// trigger-attribution.test.ts; what this file pins is that all three sites read
// the SAME resolved value, which is a property of the call sites rather than of
// any function's return.

import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(resolve(__dirname, '..', 'service.ts'), 'utf-8');

/** A whole postAuditLogToControlPlane({...}) call. The closing brace is matched
 *  at its exact indentation, which is what keeps the non-greedy body from
 *  running past the end of one call into the next. */
const AUDIT_CALL_RE = /postAuditLogToControlPlane\(\{[\s\S]*?\n {6}\}\)/g;

describe('service.ts — one triggeredBy per invocation', () => {
  it('resolves it once, from the shared helper', () => {
    expect(source).toMatch(
      /import\s+\{\s*resolveStartTriggeredBy\s*\}\s+from\s+['"]\.\/trigger-attribution['"]/,
    );
    const assignments = source.match(/const startTriggeredBy[^\n]*=/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(source).toMatch(/const startTriggeredBy: string = resolveStartTriggeredBy\(input\)/);
  });

  it('uses it on the invocation-start audit row', () => {
    expect(source).toMatch(
      /action: 'agent_invocation_started'[\s\S]{0,600}?triggeredBy: startTriggeredBy/,
    );
  });

  // Three terminal sites: executeTask's success path and its error-salvage
  // catch, which both hold the task input, and the resumed half's finalize,
  // which holds no input — it continues an invocation whose rows were written
  // from one, so it rebuilds the same value from that row through the same
  // helper. A fourth site fails here until it says which of the two it is.
  const TERMINAL_AUDIT_SITES = 3;
  const RESUMED_HALF = /triggeredBy: prior\s*\?\s*resolveStartTriggeredBy\(\{/;

  it('uses it on EVERY terminal agent_execution audit row', () => {
    const auditCalls = source.match(AUDIT_CALL_RE) ?? [];
    expect(auditCalls).toHaveLength(TERMINAL_AUDIT_SITES);
    for (const call of auditCalls) {
      expect(call).toMatch(/action: 'agent_execution'/);
      expect(call).toMatch(RESUMED_HALF.test(call) ? RESUMED_HALF : /triggeredBy: startTriggeredBy/);
    }
    expect(auditCalls.filter((c) => RESUMED_HALF.test(c))).toHaveLength(1);
  });

  it('leaves no audit site passing the raw four-value enum', () => {
    // `triggeredBy: input.triggeredBy` is still legitimate on NON-audit payloads
    // (invocation rows, replay input), which take the enum by column type. What
    // must not survive is one inside a postAuditLogToControlPlane call — and on
    // the resumed half, the row's enum must go through the helper, never
    // straight onto the row.
    const auditCalls = source.match(AUDIT_CALL_RE) ?? [];
    expect(auditCalls).toHaveLength(TERMINAL_AUDIT_SITES);
    for (const call of auditCalls) {
      expect(call).not.toMatch(/triggeredBy: input\.triggeredBy/);
      // The row's enum is the helper's INPUT there, never the audit field.
      const outsideHelper = call.replace(/resolveStartTriggeredBy\(\{[\s\S]*?\}\)/, 'resolveStartTriggeredBy(…)');
      expect(outsideHelper).not.toMatch(/triggeredBy: prior\.triggeredBy/);
    }
  });
});

describe('service.ts — the audit userId is the strict account id only', () => {
  it('sends the strict account id on every terminal audit row', () => {
    const auditCalls = source.match(AUDIT_CALL_RE) ?? [];
    expect(auditCalls).toHaveLength(3);
    for (const call of auditCalls) {
      // The task input's senderAccountId, or — on the resumed half, which has
      // no input — the same account the resume put on its context from the
      // pause payload (`messageSenderAccountId`, sourced from senderAccountId).
      expect(call).toMatch(/userId: (input\.senderAccountId|state\.context\.messageSenderAccountId)/);
    }
  });

  // The control plane validates this field as z.string().uuid() over a user_id
  // UUID column. triggeredByUserId also carries `slack:<uid>` forms, which would
  // 400 at the zod boundary and take the WHOLE audit row down with them.
  it('never sources it from the overloaded triggeredByUserId', () => {
    const auditCalls = source.match(AUDIT_CALL_RE) ?? [];
    for (const call of auditCalls) {
      expect(call).not.toMatch(/userId: input\.triggeredByUserId/);
    }
    expect(source).not.toMatch(/senderAccountId: input\.triggeredByUserId/);
  });

  it('forwards it to the control plane as the userId body field', () => {
    expect(source).toMatch(/userId: params\.userId/);
  });
});

// ── Every terminal exit retires a saturated session ──────────────────────────
//
// The check used to sit at ONE of the loop's six terminal returns. The other
// five — a recovery advisor's terminal decision, a user stop, and the same two
// again plus the error result on the throw path — skipped it silently. A funnel
// is the only shape that stays correct as the loop grows, so what this pins is
// that the funnel exists and that nothing returns around it.

describe('service.ts — the conversational loop settles through one funnel', () => {
  /** The loop body: from its declaration to the start of the next method. */
  const loopBody = (() => {
    const start = source.indexOf('private async runConversationalTurnsViaAdapter(');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('  /** Per-step usage granularity row (1.3).', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  })();

  it('reads saturation from the class, the output AND the error', () => {
    // The same fact arrives three ways. The pre-loop context-pressure
    // escalation puts it in `error`, which an output-only predicate would miss
    // — and that is the one case where the session we would keep is provably
    // the one that just failed to fit.
    expect(loopBody).toMatch(/r\.failureClass === 'context_overflow'/);
    expect(loopBody).toMatch(/contextExhaustedCompletion\(r\.output\)/);
    expect(loopBody).toMatch(/contextExhaustedCompletion\(r\.error\)/);
  });

  it('retires the session it RESTORED, not only one the adapter announced', () => {
    // A run can end before session_started ever fires. Seeding the captured id
    // from the resumed session is what lets that run retire the transcript it
    // restored instead of leaving it for the next delivery to die on.
    expect(loopBody).toMatch(
      /let capturedSdkSessionId: string \| undefined = state\.context\.resumeSessionId;/,
    );
  });

  it('defines the funnel, and the funnel is the ONLY thing that runs the check', () => {
    expect(loopBody).toMatch(/const settle = \(r: TaskExecutionResult\): TaskExecutionResult => \{/);
    expect(loopBody).toMatch(/retireAutonomousSessionIfExhausted\(r\);/);
    // Exactly one CALL — the one inside settle. (The arrow-function declaration
    // is `= (output: unknown)`, so it does not match this shape.)
    const calls = loopBody.match(/retireAutonomousSessionIfExhausted\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('routes every terminal result through it', () => {
    // A terminal result is one that names a terminalState. Each must be handed
    // to settle rather than returned directly.
    const directTerminalReturns = loopBody.match(
      /return \{[^}]*terminalState:/g,
    ) ?? [];
    expect(directTerminalReturns).toEqual([]);
    // And the funnel is genuinely used at more than the one site that had the
    // check before.
    const settled = loopBody.match(/return settle\(/g) ?? [];
    expect(settled.length).toBeGreaterThanOrEqual(9);
  });

  it('lets a paused run keep its session', () => {
    expect(loopBody).toMatch(/result = await this\.createHitlPause\([\s\S]{0,120}?return result;/);
    expect(loopBody).toMatch(/result = await this\.createClarificationPause\([\s\S]{0,200}?return result;/);
  });

  it('stops checkpointing once the session has been retired', () => {
    expect(loopBody).toMatch(/let autonomousSessionRetired = false;/);
    expect(loopBody).toMatch(
      /const persistAutonomousSession[\s\S]{0,600}?!autonomousSessionRetired/,
    );
    expect(loopBody).toMatch(/autonomousSessionRetired = true;/);
  });
});

// ── The unpriced-token counter covers every pricing site ─────────────────────

describe('service.ts — no pricing site records tokens at silent zero', () => {
  it('instruments every calculateCost call site', () => {
    // Two call sites: the run's success path and its error-salvage path. (The
    // import is a bare identifier, not a call.)
    //
    // There used to be a third — the delegated child's own billing block, a
    // second implementation that priced the child against a model resolved
    // without the entitlements chain. Delegated children now run through
    // executeTask, so they are billed by the same two sites as every other run
    // and there is no separate delegation pricing path to keep in step.
    //
    // Asserted as a PAIRING rather than as two magic numbers: what matters is
    // that no pricing site is left uninstrumented, which is what "records tokens
    // at silent zero" means. A new call site now fails this whether or not
    // anyone remembers to bump a count.
    // The pricing SITE marker is priceRunSteps, not calculateCost. Runs are now
    // priced one step at a time — a conditional rate band keys off a single
    // request's prompt size, so pricing the run-wide sum would charge a
    // long-context band no step reached — and the per-step calculateCost calls
    // moved inside that helper. Its two call sites are the things that must be
    // instrumented; the helper returns null on a rate miss exactly as the single
    // call did.
    // Call sites only. calculateCost was imported, so every match was a site;
    // priceRunSteps is declared HERE, so its declaration has to be excluded or
    // the `+ 2` below silently means something different.
    const costCalls = source.match(/(?<!function )priceRunSteps\(/g) ?? [];
    const recorded = source.match(/recordUnpricedTokens\(/g) ?? [];

    // And calculateCost must not reappear directly in a completion path, which
    // would be a pricing site this pairing cannot see. Every occurrence belongs
    // to priceRunSteps.
    const rawPricing = source.match(/calculateCost\(/g) ?? [];
    expect(rawPricing).toHaveLength(2);
    const helperBody = source.slice(
      source.indexOf('function priceRunSteps('),
      source.indexOf('function recordUnpricedTokens('),
    );
    expect(helperBody.match(/calculateCost\(/g) ?? []).toHaveLength(rawPricing.length);
    // One declaration + one call per pricing site, PLUS one in
    // recordCodeSessionUnpriced. That last one is deliberately NOT paired with
    // a calculateCost: a nested coding session whose vendor named no model has
    // no rate to look up, so its tokens are counted as unpriced instead of
    // billed at a guess. It is called from BOTH completion paths — asserted
    // below, because a single definition called once would meter only half the
    // runs.
    //
    // Derived from the pricing-site count rather than written as a literal, so
    // adding a pricing site fails this whether or not anyone remembers to bump
    // a number. The `+ 2` is the declaration and the unpaired code-session
    // site, both of which are named and asserted individually right here.
    expect(recorded).toHaveLength(costCalls.length + 2);
    // Three completion paths: executeTask's success and salvage, and the
    // resumed half's finalize, which completes the invocation it continued.
    const unpricedCodeSession = source.match(/this\.recordCodeSessionUnpriced\(/g) ?? [];
    expect(unpricedCodeSession).toHaveLength(3);
    // And the nested cost reaches the billed figure from every path too.
    const folded = source.match(/\+ codeSessionCost\.costUsd/g) ?? [];
    expect(folded).toHaveLength(3);
  });

  it('prices every completion path through the same model resolution', () => {
    // The success path and the error-salvage path must name the SAME model for
    // the same tokens. They did not: salvage read `modelConfig?.modelId || null`
    // with no routing and no tier fallback, so a run that failed was priced at
    // nothing while an identical run that succeeded was priced properly — the
    // tokens were spent either way. One definition, called from all three.
    const pricingResolves = source.match(/this\.modelIdForPricing\(/g) ?? [];
    expect(pricingResolves).toHaveLength(3);
    // And it is the non-throwing one: resolveInvocationModelId raises for a
    // provider with no tier catalogue, which on the salvage path would replace
    // the original error and skip the invocation's completion write entirely.
    expect(source).toMatch(/private async modelIdForPricing[\s\S]{0,600}?catch \(err\)/);
  });
});

// ── The two rows agree about the AGENT id space, not just the shape ──────────
//
// internal_agents.id and agents.id are disjoint (INV-TR-010). The start row goes
// through the outbox, which translates; the terminal rows are posted directly
// and would send the runtime id unchanged. That would leave the two rows for one
// invocation disagreeing again — and the terminal row is the one the Activity
// page renders, so the name it exists to resolve would still come back empty.

describe('service.ts — the direct audit post resolves the agent id space', () => {
  it('translates triggeredBy before conforming it', () => {
    expect(source).toMatch(
      /triggeredBy: conformTriggeredBy\(\s*\n\s*await translateTriggeredByAgentId\(params\.triggeredBy, \{/,
    );
  });

  it('hands the translator the ids it already resolved, so a self-trigger costs no query', () => {
    expect(source).toMatch(/runtimeAgentId: params\.agentId,/);
    expect(source).toMatch(/internalAgentId,/);
  });

  it('imports it from the audit module rather than keeping a second copy', () => {
    expect(source).toMatch(
      /import \{ conformTriggeredBy, translateTriggeredByAgentId \} from '\.\.\/audit\/service';/,
    );
  });
});

// ── The human reaches the control plane on BOTH rows ─────────────────────────

describe('service.ts — the start row carries the human too', () => {
  it('sets userId on the invocation-start audit row', () => {
    expect(source).toMatch(
      /action: 'agent_invocation_started'/,
    );
    expect(source).toMatch(
      /insertAuditLog\(null, input\.tenantId, \{[\s\S]{0,400}?userId: input\.senderAccountId,/,
    );
  });
});

// ── A saturated CHAT session is cleared, not merely not-written ───────────────
//
// A failed chat turn writes no JSONL, which keeps a half-written transcript from
// being persisted — but it also leaves the PREVIOUS row in place. When the
// failure is an exhausted window, that row is the conversation that no longer
// fits, and every later turn restores it and overflows again. Worse, the class
// is marked retryable, so the retry would resume straight back into it. The
// success branch skips the write; the failure branch has to undo one.

describe('chat-turn-handler.ts — both halves of the saturation guard', () => {
  const chat = readFileSync(
    resolve(__dirname, '..', '..', 'interactive-chat', 'chat-turn-handler.ts'),
    'utf-8',
  );

  it('skips the write when a SUCCEEDING turn reports no room left', () => {
    // Reads the LAST assistant message rather than the whole turn text. A turn
    // is several messages and `outputText` now holds all of them, while
    // contextExhaustedCompletion deliberately bails above 600 characters — so
    // feeding it the accumulated turn would push a real capitulation past the
    // cap and quietly switch this guard off. The capitulation is the final
    // message; that is what gets checked.
    expect(chat).toMatch(/const saturated = contextExhaustedCompletion\(lastAssistantText\);/);
    expect(chat).toMatch(/if \(updatedJsonl && !saturated\)/);
  });

  it('clears the stored session when a FAILING turn reports no room left', () => {
    expect(chat).toMatch(
      /if \(failureClass === 'context_overflow'\)[\s\S]{0,200}?clearChatSessionJsonl\(threadId, runtimeAgentIdForRun\)/,
    );
  });

  it('clears by deleting the row, since chat_sessions keeps no history to protect', () => {
    expect(chat).toMatch(
      /DELETE FROM chat_sessions WHERE thread_id = \$1 AND agent_id = \$2/,
    );
  });

  it('never lets the clear turn a reported failure into a thrown one', () => {
    expect(chat).toMatch(
      /async function clearChatSessionJsonl[\s\S]{0,600}?catch \(err\)[\s\S]{0,300}?logger\.warn/,
    );
  });
});
