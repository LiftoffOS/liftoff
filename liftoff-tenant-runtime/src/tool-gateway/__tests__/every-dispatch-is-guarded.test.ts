// Every path that reaches a vendor runs the guard chain.
//
// `execute()`'s own header says the wrapper exists so "a future early return
// cannot silently opt out of the audit, which is exactly how this was lost the
// first time". A wrapper stops an early return INSIDE it. It cannot stop a
// caller that never enters — and three were added that do not:
//
//   the Composio route      dispatches from the MCP server (mcp-server.ts)
//   executeBatch's fast path dispatches over RPC (service.ts)
//   a vendor-hosted MCP server is dispatched by the vendor SDK itself
//
// Each ran to the vendor with no capability check, no repository scope, no
// provenance judgement and no duplicate-outward guard. Not disabled — never
// entered, which is why the only symptom was an absence of telemetry, and why
// a readiness report read every connector as "never exercised".
//
// All three are guarded before dispatch now. The first two through the chain
// itself; the third at the adapter gate (`runAdapterHitlGate`), which every
// engine calls for every tool before the vendor SDK runs it — Anthropic through
// `canUseTool`, the wire engines through mcp-bridge — and which is the one
// place a direct-dispatch write can be refused.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Call sites that hand work to a vendor. Each must be preceded, in its own
 *  file, by the guard chain — or be `execute` itself, which IS the chain. */
const DISPATCH_SITES: ReadonlyArray<{ file: string; dispatcher: RegExp; guard: RegExp; why: string }> = [
  {
    file: 'tool-gateway/mcp-server.ts',
    dispatcher: /dispatchComposio(WithPolling)?\(/,
    guard: /preDispatchGuards\(/,
    why: 'the Composio route dispatches to the vendor without calling execute()',
  },
  {
    file: 'tool-gateway/service.ts',
    dispatcher: /client\.executeBatch\(/,
    guard: /preDispatchGuards\(/,
    why: "executeBatch's fast path dispatches over RPC without calling execute()",
  },
];

describe('every dispatch path runs the guard chain', () => {
  it.each(DISPATCH_SITES)('$file guards before $why', ({ file, dispatcher, guard }) => {
    const source = read(file);
    // Guards the test itself: if the dispatcher were renamed, an assertion that
    // only checked for the guard would pass while checking nothing.
    expect(dispatcher.test(source)).toBe(true);
    expect(guard.test(source)).toBe(true);
  });

  it('keeps the chain in ONE place', () => {
    // Four checks, defined once. They were inlined in `execute` and therefore
    // impossible to run from anywhere else without copying them — and a copied
    // guard chain drifts exactly the way the Composio branch drifted from the
    // native one, one property at a time.
    const service = read('tool-gateway/service.ts');
    for (const g of [
      'guardCapabilityTriState',
      'guardRepoScope',
      'guardWriteProvenance',
      'findDuplicateOutwardAction',
    ]) {
      const calls = service.split(`this.${g}(`).length - 1;
      expect({ guard: g, callSites: calls }).toEqual({ guard: g, callSites: 1 });
    }
  });

  it('exposes the chain on the dispatcher, so a split deployment can reach it', () => {
    // The provenance store is in-process and belongs to whichever process owns
    // the gateway. Every deployment today sets TOOL_GATEWAY_SERVICE_URL, so a
    // caller evaluating the chain locally would judge a write against a store
    // that never saw the run's reads. Both implementations must carry it.
    expect(read('tool-gateway/dispatcher.ts')).toMatch(/preDispatchGuards\(/);
    expect(read('tool-gateway/http-client.ts')).toMatch(/tool-calls\/guard/);
    expect(read('tool-gateway/router.ts')).toMatch(/'\/tool-calls\/guard'/);
  });

  // THE PAIRING, which is the one that broke. A route that CHECKS provenance
  // without RECORDING it judges its writes against a store that never saw its
  // reads — every write flags, none legitimately. The first live run after the
  // check was wired flagged a Gmail draft for a thread id the same run had read
  // minutes earlier through the same route.
  //
  // Worse than having neither: shadow fills with false positives, and the
  // reading of that telemetry — "this connector is not ready to enforce" — is
  // indistinguishable from a connector that genuinely is not.
  it('records on every route that checks', () => {
    const service = read('tool-gateway/service.ts');
    // The self-dispatch recorder does BOTH halves, in the process that owns the
    // store.
    const body = service.slice(service.indexOf('async recordSelfDispatched('));
    expect(body.slice(0, 400)).toMatch(/recordProvenanceForResult\(/);
    expect(body.slice(0, 400)).toMatch(/backstopLedger\(/);
  });

  it('waits for the record before the next call is judged', () => {
    // Fire-and-forget would race: the guard on the NEXT tool call asks the store
    // what this run has read, and a record still in flight is a record it does
    // not see. A read-then-write pair inside one turn would then flag itself.
    const mcp = read('tool-gateway/mcp-server.ts');
    expect(mcp).toMatch(/await toolGateway\.recordSelfDispatched\(/);
    expect(mcp).not.toMatch(/void toolGateway\.recordSelfDispatched\(/);
  });

  it('ledgers the Composio route, which reads its own actions back', () => {
    // The branch wrote an `audit_logs` row and nothing else, and
    // `have_i_acted_on` reads `actions`. An agent on a Composio-served
    // connector therefore had no memory of what it had done — it posts, the
    // trigger is redelivered, it asks, and is told no.
    const mcp = read('tool-gateway/mcp-server.ts');
    expect(mcp).toMatch(/recordSelfDispatched\(/);
    // Through the dispatcher, because the ledger belongs to the gateway's
    // process exactly as the provenance store does.
    expect(read('tool-gateway/router.ts')).toMatch(/'\/tool-calls\/self-dispatched'/);
    expect(read('tool-gateway/http-client.ts')).toMatch(/tool-calls\/self-dispatched/);
    // The row is the one backstopLedger writes, not a second similar one: a
    // parallel writer is how this branch drifted from the native path before.
    const service = read('tool-gateway/service.ts');
    expect(service.split('this.backstopLedger(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('guards the vendor-SDK path at the adapter gate, before dispatch', () => {
    // The one seam every engine passes before a vendor-hosted tool runs. It
    // is where a direct-dispatch write is judged and can be held — and it goes
    // through the dispatcher, because the store lives in the gateway's process.
    const svc = read('agent-execution/service.ts');
    const gate = svc.slice(svc.indexOf('private async runAdapterHitlGate('));
    const gateBody = gate.slice(0, gate.indexOf('await commitBlastRadius('));
    // The judgement is one helper, and the gate reaches it TWICE: on the
    // structured-resume path, on what an operator approved (possibly edited
    // to a target the run never read), and on the first pass — BEFORE every
    // HITL pause, so a person is never asked about an ungrounded write, and
    // BEFORE the blast-radius commit, which is "cleared every gate": a hold
    // after it would charge the run for work that never happens.
    const holds = gateBody.match(/await this\.vendorProvenanceHold\(/g) ?? [];
    expect(holds).toHaveLength(2);
    const firstPause = gateBody.search(/hitlPause:/);
    const firstHold = gateBody.indexOf('await this.vendorProvenanceHold(');
    expect({ resumeJudged: gateBody.indexOf('editedInput ?? args') > 0, firstHold, firstPause })
      .toEqual({ resumeJudged: true, firstHold, firstPause: expect.any(Number) });
    expect(gateBody.lastIndexOf('await this.vendorProvenanceHold(')).toBeLessThan(firstPause);
    const helper = svc.slice(svc.indexOf('private async vendorProvenanceHold('), svc.indexOf('private async runAdapterHitlGate('));
    expect(helper).toMatch(/this\.toolGateway\.guardExternal\(/);
    expect(read('tool-gateway/router.ts')).toMatch(/'\/tool-calls\/guard-external'/);
    expect(read('tool-gateway/http-client.ts')).toMatch(/tool-calls\/guard-external/);
  });

  it('produces every adapter-gate pause through the one helper that asks the completed-act hold', () => {
    // A person is never asked to approve an act this run already completed.
    // That holds only if every pause the gate can produce asks first, and a
    // pause site added tomorrow that builds its own `hitlPause` would not.
    // So the gate body may construct a pause in exactly ONE place — inside
    // `pauseUnlessDone` — and every site reaches it by calling that helper.
    // The three sites today are the write-capability pause, the checkHitlGate
    // pause, and the Communication pre-check pause; the third was the one
    // wired last, which is why this is asserted rather than remembered.
    const svc = read('agent-execution/service.ts');
    const gate = svc.slice(svc.indexOf('private async runAdapterHitlGate('));
    const gateBody = gate.slice(0, gate.indexOf('await commitBlastRadius('));
    const constructions = gateBody.match(/hitlPause:/g) ?? [];
    expect(constructions).toHaveLength(1);
    const helper = gateBody.indexOf('const pauseUnlessDone = async (');
    expect(helper).toBeGreaterThan(0);
    expect(gateBody.indexOf('hitlPause:')).toBeGreaterThan(helper);
    // The helper asks the hold, and the sites use the helper: one definition
    // plus one call per pause site.
    expect(gateBody.slice(helper)).toMatch(/await completedActHold\(state\.context, toolName, args\)/);
    const calls = gateBody.match(/return pauseUnlessDone\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('records the vendor-SDK path in the store that judges, through the dispatcher', () => {
    // The RESULT is only visible after the call returns, so recording lives
    // after it — on the bridge for engines that can wait, on the event stream
    // for the rest — and reaches the gateway's process either way, for the
    // same reason the guard does. ONE function makes that record.
    expect(read('tool-gateway/router.ts')).toMatch(/'\/tool-calls\/observe-external'/);
    const remember = read('agent-execution/remember-external-tool-call.ts');
    expect(remember).toMatch(/getToolGatewayDispatcher\(\)\.observeExternal\(/);
    for (const f of ['agent-execution/service.ts', 'interactive-chat/chat-turn-handler.ts', 'agent-execution/remember-external-tool-call.ts']) {
      // Not the local functions: those write to this process's store.
      expect({ file: f, local: /(observeExternalToolCall|recordExternalToolResult|guardExternalToolCall)\(/.test(read(f)) })
        .toEqual({ file: f, local: false });
    }
  });

  it('remembers a call the gateway never saw through ONE function, from every seam', () => {
    // The ledger row and the provenance record were made in three places
    // with the same lines each; a fourth caller — the bridge, which WAITS for
    // the record before the model sees the result — is how a fourth copy
    // would have drifted. Every seam goes through `rememberExternalToolCall`,
    // which translates the engine's name to the SDK form, and skips a call
    // the engine already remembered at dispatch.
    for (const file of ['agent-execution/service.ts', 'interactive-chat/chat-turn-handler.ts']) {
      const src = read(file);
      expect({ file, direct: /recordExternalToolCall\(\{|observeExternal\(\{/.test(src) }).toEqual({ file, direct: false });
      // Under the id the bridge recorded it under, when the engine could only
      // hand that back on the result (the HTTP-MCP engines): the same ledger
      // row, not a second one keyed by the engine's id.
      //
      // An OBSERVER seam is told the outcome at dispatch and WAITED FOR, and
      // is recognised by its shape — `remembered(await rememberExternalToolCall(`
      // — whether it is registered on an engine or handed to a bridge context
      // directly (the HITL resume's approved dispatch does the latter). Every
      // other call site is a stream seam.
      const streamSeams = (src.match(/rememberExternalToolCall\(\{/g) ?? []).length
        - (src.match(/remembered\(await rememberExternalToolCall\(\{/g) ?? []).length;
      const underDispatchId = (src.match(/callId: event\.dispatchCallId \?\? event\.callId,/g) ?? []).length;
      expect({ file, streamSeams, underDispatchId }).toEqual({ file, streamSeams, underDispatchId: streamSeams });
      for (const m of src.matchAll(/rememberExternalToolCall\(\{/g)) {
        // The stream seams (not the observer seams) check the marker.
        const before = src.slice(Math.max(0, m.index! - 700), m.index!);
        const isRegistration = /remembered\(await\s*$/.test(before);
        if (!isRegistration) {
          expect({ file, at: m.index, skipsRecorded: /recordedAtDispatch/.test(before) }).toEqual({ file, at: m.index, skipsRecorded: true });
        }
      }
    }
    // The gate seam still translates the name itself: it is pre-call, and
    // remembers nothing.
    const svc = read('agent-execution/service.ts');
    const gate = svc.slice(svc.indexOf('private async vendorProvenanceHold('), svc.indexOf('await commitBlastRadius('));
    expect(gate).toMatch(/sdkCallNameFor\(/);
  });

  it('waits for the record on the bridge, before the result reaches the model', () => {
    // The engine does not wait for stream listeners before its next model
    // turn. The bridge is the one point on a wire engine that can wait, and
    // it must — on the dispatched result, on a denied gate, on a thrown
    // dispatch — and the service must give it something to wait for.
    const bridge = read('agent-execution/adapter/mcp-bridge.ts');
    expect((bridge.match(/await observeOutcome\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(read('agent-execution/service.ts').split('registerToolResultObserver?.(').length - 1).toBe(2);
    // The wire adapter implements the hook and marks what it recorded.
    const wire = read('agent-execution/adapter/openai-wire/index.ts');
    expect(wire).toMatch(/registerToolResultObserver\(/);
    expect(wire).toMatch(/recordedAtDispatch/);
  });

  it('judges a direct-dispatch write exactly once', () => {
    // The gate reports the verdict; the stream records the result. If the
    // recorder also reported, every vendor-hosted write would be counted twice
    // in the denominator the readiness report reads.
    const ext = read('tool-gateway/external-provenance.ts');
    const recorder = ext.slice(ext.indexOf('export function recordExternalToolResult('));
    expect(recorder).not.toMatch(/reportProvenance\(/);
    expect(recorder).not.toMatch(/checkWriteProvenance\(/);
  });
});

describe('every path a result reaches the model by runs the output guardrails', () => {
  // The input side above had this shape for months while the OUTPUT side did
  // not: the Composio route checked the call and then handed the vendor's
  // response straight to the model — no secret scrub, no egress lift — and
  // both guardrails' tests passed against `execute()`, the path that never
  // carried a Composio result. The same asymmetry, one direction over.
  const OUTPUT_SITES: ReadonlyArray<{ file: string; dispatcher: RegExp; guardrails: RegExp; why: string }> = [
    {
      file: 'tool-gateway/mcp-server.ts',
      dispatcher: /dispatchComposio(WithPolling)?\(/,
      guardrails: /runOutputGuardrails\(/,
      why: 'the Composio route returns the vendor response to the model without execute()',
    },
    {
      file: 'tool-gateway/service.ts',
      dispatcher: /client\.executeBatch\(/,
      guardrails: /applyOutputGuardrails\(/,
      why: "executeBatch's fast path returns results without execute()",
    },
  ];

  it.each(OUTPUT_SITES)('$file guards the output where $why', ({ file, dispatcher, guardrails }) => {
    const source = read(file);
    expect(dispatcher.test(source)).toBe(true);
    expect(guardrails.test(source)).toBe(true);
  });

  it('the bridge never serialises a gateway result it has not passed through forModel', () => {
    // The gateway hands lifted values back BESIDE the data on the internal
    // hop, for the bridge to re-record in its own process and strip. A call
    // site that serialises the raw result — `JSON.stringify(result)` on a
    // whole response — would put the lifted value back into the model's
    // context one hop later than the guardrail took it out. So every
    // `toolGateway.execute(` in the bridge is either wrapped in `forModel(`
    // or is a thunk whose every call is.
    const source = read('tool-gateway/mcp-server.ts');
    const calls = [...source.matchAll(/^(.*)toolGateway\.execute\(/gm)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(3);
    const unwrapped = calls.filter((prefix) => !/forModel\(await $/.test(prefix) && !/=> $/.test(prefix));
    expect(unwrapped).toEqual([]);
    for (const thunk of ['runSlack', 'runTeams']) {
      const uses = [...source.matchAll(new RegExp(`(?<!const )${thunk}\\(\\)`, 'g'))].length;
      const wrapped = [...source.matchAll(new RegExp(`forModel\\(await ${thunk}\\(\\)`, 'g'))].length;
      expect({ thunk, uses, wrapped }).toEqual({ thunk, uses, wrapped: uses });
    }
  });
});

describe('the connector routes of the MCP server hand the gateway the same turn identity', () => {
  // The Composio route's input is documented as "built from the same fields
  // the native executeInput uses, so both routes are judged on identical
  // grounds" — and `threadId` was on neither, while `ExecuteInput` documents
  // it as populated for chat-turn calls. A per-turn hook that keyed on it saw
  // every chat-turn connector call through this server as autonomous.
  //
  // Pinned per builder, by the literal first line of each. The file has four
  // builders; the two that dispatch a CONNECTOR tool for the model carry the
  // full identity. The corpus-search fan-out and the external-agent route are
  // enumerated so a fifth builder, or a change to these two, is a decision
  // made here rather than a field that quietly went missing.
  // `turnId` joins `threadId` for the same reason it did: a found file becomes
  // a card stamped with the turn that found it, and a builder that drops the
  // id writes a card no reply can be checked against.
  const TURN_IDENTITY = ['tenantId', 'agentId', 'instructionVersion', 'traceId', 'triggerKey', 'invocationId', 'threadId', 'turnId'];

  it('carries the full identity on both connector-dispatch builders, and names every other builder', () => {
    const src = read('tool-gateway/mcp-server.ts');
    const builders = [...src.matchAll(/const (guardInput|executeInput): InternalExecuteInput = \{\s*(?:\/\/[^\n]*\n\s*)*([^\n]+),/g)]
      .map((m) => ({ name: m[1], firstLine: m[2] }));
    expect(builders.map((b) => b.name)).toEqual(['guardInput', 'executeInput', 'executeInput', 'executeInput']);

    const [composioGuard, nativeExecute, corpusSearch, externalAgent] = builders;
    for (const b of [composioGuard, nativeExecute]) {
      for (const field of TURN_IDENTITY) {
        expect({ builder: b.name, has: field, line: b.firstLine })
          .toEqual({ builder: b.name, has: field, line: expect.stringContaining(field) });
      }
    }
    // The search fan-out and the external-agent route never hand the person a
    // file and carry no trigger key; asserted as they are, not as an oversight.
    expect(corpusSearch.firstLine).toBe('tenantId, agentId, instructionVersion, traceId, invocationId');
    expect(externalAgent.firstLine).toBe('tenantId, agentId, instructionVersion, traceId, invocationId');
  });
});

describe('the standard-tool context carries the turn to the document handlers', () => {
  // The other hop `turnId` did not travel. It reached the catalog builder's
  // input and stopped there — read by the recall tool, never put on the
  // context a tool handler sees — so a document tool registering a deck it
  // wrote into Drive had no turn to stamp the card with. Pinned by the
  // literal, the same way the builders above are.
  it('sets turnId on the StandardToolContext literal, beside threadId', () => {
    const src = read('tool-gateway/mcp-server.ts');
    const start = src.indexOf('const stdToolCtx: StandardToolContext = {');
    expect(start).toBeGreaterThan(0);
    const literal = src.slice(start, src.indexOf('};', start));
    expect(literal).toMatch(/^\s*threadId,\s*$/m);
    expect(literal).toMatch(/^\s*turnId,\s*$/m);
  });

  it("is the runtime's own field on the context type, not a cast at the call site", () => {
    const types = read('tools/standard-tool-handler.ts');
    const ctx = types.slice(types.indexOf('export interface StandardToolContext {'));
    expect(ctx.slice(0, ctx.indexOf('\n}'))).toMatch(/^\s*turnId\?: string;/m);
  });
});
