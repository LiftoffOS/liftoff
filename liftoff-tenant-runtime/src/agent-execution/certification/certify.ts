// Contract-level (level 1) engine certification — BEHAVIORAL.
//
// certifyEngine() DRIVES a concrete engine's adapter through the platform
// contract and consumes its event streams, so the async-generator bodies of
// invoke()/resume() actually execute and their behavior is asserted — not merely
// that they return an async iterable. It runs against a transport the CALLER has
// armed: a per-engine jest test mocks the vendor SDK to emit a canned stream
// (level 1, every PR); the live runner (certify-engines.ts) runs the real SDK in
// a controlled tenant (level 3). Same checks, both levels.
//
// certifyEngine certifies a CONCRETE engine (an ExecutionEngineId + its
// constructed adapter) DRIVEN AS A CONCRETE PROVIDER — Codex separate from
// OpenAI-Agents, ADK from GenAI, OpenCode from the OpenAI-wire adapter, and
// OpenCode-from-xAI's-account separate from OpenCode-from-OpenRouter's — and
// emits the machine-readable EngineCertificationResult that promotion
// automation consumes. The pairs come from the vendor record
// (`engineProviderPairs`), so an engine that serves two configurations is
// certified in both.
//
// SCOPE — this is level 1 (contract surface + core stream behavior: valid stream,
// exactly-one-terminal, clean-success, usage, real abort-interruption, pause-token
// round-trip, resume round-trip). The DEEP governed behaviors are certified at
// level 2 by the dedicated per-adapter fixture suites, which also run on every PR:
//   - tool dispatch through the Liftoff seam ......... adapter/__tests__/mcp-bridge*, openai-vendor-mcp
//   - tool name/args/result/error normalization ...... adapter/__tests__/tool-result-*, vendor-mcp-classify
//   - HITL pause boundary + denial side-effect suppression .. adapter/__tests__/hitl-pause-emit
//   - cross-engine contract parity ................... adapter/__tests__/{cross-adapter,openai}-equivalence
//   - no-stub-success (a tool that cannot dispatch never fabricates success) .. eslint-rules/no-stub-success-fallback
// Level 3 is the live canary (scripts/certify-engines.ts → real provider calls).

import { writeFileSync } from 'fs';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../adapter/types';
import { engineProviderPairs, pairsForEngine, type EngineProviderPair } from '../adapter/vendors';
import type {
  VendorSdkAdapter, ExecutionEngineId, McpToolCatalog, InvocationInput, InvocationEvent,
} from '../adapter';
import {
  CERTIFICATION_CONTRACT_VERSION,
  type CertificationCategory,
  type CertificationCheck,
  type EngineCertificationResult,
} from './types';
import { resolveModelForTier } from '../../llm/tiers';
import {
  fidelityFixtureFor,
  fixtureReproduces,
  FIDELITY_FIXTURES,
  REBUILD_CONVERSATION_FIXTURE,
  REBUILD_CONVERSATION_FACTS,
} from '../../trajectories/fidelity-fixtures';

/** Source engines a rebuild is exercised FROM. Every engine that records a
 *  canonical conversation is a possible source; the conversation fixture is
 *  engine-neutral, so the source only selects the repair path taken.
 *
 *  Derived, because the rule above already says which engines qualify and every
 *  resolvable engine records. A written-out list drifts, and the engines it
 *  omits are exactly the ones whose rebuild path then goes unexercised. */
const REBUILD_SOURCE_ENGINES: readonly ExecutionEngineId[] = RESOLVABLE_EXECUTION_ENGINE_IDS;
import { repairForReplay } from '../../trajectories/repair';
import { canonicalToEngine, inverseMapperShipped } from '../../trajectories/inverse';
import { SDK_HOOK_CONTRACT_PROBES, hookContractUnrunnableReason } from './sdk-hook-contract';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalizeToolName } from '../../hitl-enforcement/tool-name-resolution';

export interface CertifyOptions {
  /** SDK/CLI version of the engine in the image under certification. */
  runtimeVersion?: string;
  /** Built image revision (git sha / digest) under certification. */
  imageRevision?: string;
  /** Safety cap on events drained from a stream (guards a non-terminating adapter). */
  maxEvents?: number;
  /** The provider to drive the engine as. One engine can serve more than one
   *  (opencode: xAI's account and OpenRouter's), and each is a configuration
   *  of its own. Defaults to the engine's first pair, which is the one it is
   *  the normal choice for. */
  provider?: InvocationInput['provider'];
  /** Drive the engine against a LIVE catalog — the probe tool served by a
   *  real in-process MCP server — and hold it to the model CALLING that tool.
   *  Off in the mocked level-1 suite, whose vendor mocks never call a tool;
   *  on in the live certification job, which is the only place the claim
   *  "this engine's catalog reaches its model" can be made at all. */
  liveCatalog?: boolean;
}

/** Every (engine, provider) pair certification covers, from the vendor record.
 *
 *  DERIVED, and per PAIR. It was a map of one provider per engine, and that was
 *  wrong twice over: written out, it gave the xAI engine `openrouter` — the
 *  probe resolved the small tier off OpenRouter's map and asked api.x.ai for
 *  `z-ai/glm-4.7-flash`, which 404s — and derived one-per-engine, it would
 *  have certified opencode as xAI alone once Grok moved onto it, leaving the
 *  OpenRouter configuration every open-weights agent runs on untested. The
 *  sibling copy in the cache benchmark reads the same list. */
export const CERTIFICATION_PAIRS: readonly EngineProviderPair[] = engineProviderPairs();

/** The provider a probe drives an engine as when the caller names none: the
 *  engine's first pair. The sentinel belongs to no vendor and is never driven;
 *  it falls back to anthropic so the probe still has a well-formed input to be
 *  refused on. */
function defaultProbeProvider(engine: ExecutionEngineId): InvocationInput['provider'] {
  return pairsForEngine(engine)[0]?.provider ?? 'anthropic';
}

/**
 * The probe tool carries a REAL argument schema, not `{ type: 'object' }`.
 *
 * An empty schema cannot detect the failure it most needs to: every engine that
 * is not Anthropic saw tools with no arguments at all for three months, across
 * 69 wire-engine runs with zero successes, and the round-trip check passed
 * throughout — because a tool with no arguments is indistinguishable from a
 * tool whose arguments were dropped.
 *
 * Arguments are also the provenance gate's whole input. The gate asks which
 * argument of a write names a record; on an engine that strips arguments it
 * inspects nothing while reporting fine. So this schema is the per-engine
 * precondition for enforcing provenance at all.
 */
function minimalCatalog(): McpToolCatalog {
  return {
    servers: [],
    tools: [{
      name: 'probe_tool',
      description: 'certification probe',
      inputSchema: {
        type: 'object',
        properties: {
          record_id: { type: 'string', description: 'the record this acts on' },
          note: { type: 'string', description: 'free text' },
        },
        required: ['record_id'],
      },
      serverId: 'liftoff-tool-gateway',
    }],
  };
}

/** The probe schema's argument names, as the round-trip check expects them. */
const PROBE_ARGS = { required: 'record_id', optional: 'note' } as const;

/**
 * The probe catalog with its tool LIVE: the same `probe_tool` schema the
 * round-trip check reads, served by a real in-process MCP server the way the
 * tool gateway serves every catalog tool, so an engine that calls it gets an
 * answer rather than an adapter throwing for want of an executor.
 *
 * Every engine reaches it by its own route — the Claude Agent SDK takes the
 * server config as one of its MCP servers, the bridge engines pair an
 * in-memory transport with the instance, and the external processes reach it
 * through the HTTP MCP the adapter exposes — which is the point of the check
 * that uses it: the route is per engine, so the evidence has to be.
 */
export function liveProbeCatalog(): McpToolCatalog {
  const instance = new McpServer({ name: 'liftoff-tool-gateway', version: '1.0.0' });
  instance.registerTool(
    'probe_tool',
    {
      description: 'certification probe',
      inputSchema: { record_id: z.string(), note: z.string().optional() },
    },
    async (args) => ({ content: [{ type: 'text' as const, text: `probe ok: ${args.record_id}` }] }),
  );
  // Typed off the catalog rather than the vendor SDK: the SDK's config type
  // does not leave the adapter layer, and the catalog's in-process entry is it.
  type InProcessServer = Extract<McpToolCatalog['servers'][number], { kind: 'in-process' }>;
  const config: InProcessServer['config'] = { type: 'sdk', name: 'liftoff-tool-gateway', instance };
  return {
    servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config }],
    tools: minimalCatalog().tools,
  };
}

/** Whether a call name the stream reported is the probe tool, whatever the
 *  engine wrapped it in: `mcp__liftoff-tool-gateway__probe_tool` on the Claude
 *  SDK, `mcp_liftoff_probe_tool` on the Gemini CLI, bare on the rest. */
export function namesProbeTool(callName: string): boolean {
  const bare = normalizeToolName(callName);
  return bare === 'probe_tool' || /(^|_)probe_tool$/.test(bare);
}

/** Engines whose behavioral probe needs a SPECIFIC model, not the generic
 *  small-tier one. openai-codex runs the Codex SDK, which always attaches its
 *  built-in `tool_search`; the small nano model rejects it, so the codex probe
 *  needs a Codex-class model. Every OLDER codex model (gpt-5[.1|.2]-codex*) is
 *  now DEPRECATED — gpt-5.3-codex is the only current one. */
export const ENGINE_PROBE_MODEL: Partial<Record<ExecutionEngineId, string>> = {
  'openai-codex': 'gpt-5.3-codex',
};

function probeInput(engine: ExecutionEngineId, provider: InvocationInput['provider']): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'certification probe' }] }],
    systemPrompt: 'sys',
    // A REAL, cheap model — an engine-specific override where the generic tier
    // model is unsuitable (see ENGINE_PROBE_MODEL), else the platform's own tier
    // map. A live provider rejects a bogus model name, so a placeholder would fail
    // level-3 for reasons unrelated to the contract. Mocked level-1 ignores it.
    model: ENGINE_PROBE_MODEL[engine] ?? resolveModelForTier(provider, 'small'),
    provider,
    tenantId: 'cert',
    invocationId: `cert-${engine}-${provider}`,
    // Not an agent run. A stable identity of its own, so it neither shares a
    // prompt-cache lane with real traffic nor fragments into one per probe.
    agentId: `cert-${engine}-${provider}`,
  };
}

/** The turn that asks for the probe tool by name. Direct, so a model that can
 *  see the tool calls it and a model that cannot has nothing else to do with
 *  the request: "certification probe" alone leaves a lazy model free to answer
 *  in text, and the check unable to tell blindness from choice. */
function catalogProbeInput(engine: ExecutionEngineId, provider: InvocationInput['provider']): InvocationInput {
  return {
    ...probeInput(engine, provider),
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'Call the tool named probe_tool with record_id set to "cert-1", then reply with the word done.' }],
    }],
    invocationId: `cert-catalog-${engine}-${provider}`,
    maxTurns: 3,
  };
}

const DRAIN_TIMEOUT = Symbol('drain-timeout');

/** Consume an adapter event stream to completion (or to a safety cap / abort),
 *  so the generator body actually runs. A WALL-CLOCK timeout bounds each pull so
 *  an engine that stalls before yielding cannot hang certification — a stall
 *  yields a synthetic error terminal, which (correctly) fails the clean-success
 *  check. Returns the collected events. */
/** How long a drain waits for the NEXT event before calling the stream dead.
 *
 *  30s failed two engines that were working. Both route through OpenRouter,
 *  which fans out to third-party hosts, and neither reached a terminal inside
 *  the window — reported as `certification_drain_timeout`, which reads as a
 *  contract violation and is a latency one. The four engines on first-party
 *  endpoints answer in seconds and are unaffected either way.
 *
 *  Still bounded, and still catches the failure this exists for: the opencode
 *  stall that prompted it sat silent for 174 seconds. */
const DRAIN_TIMEOUT_MS = 90_000;

async function drain(
  stream: AsyncIterable<InvocationEvent>,
  signal: AbortSignal,
  cap: number,
  timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  const it = stream[Symbol.asyncIterator]();
  const deadlineAt = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      out.push({ type: 'completion', outcome: 'error', reason: 'certification_drain_timeout' });
      break;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof DRAIN_TIMEOUT>((r) => { timer = setTimeout(() => r(DRAIN_TIMEOUT), remaining); });
    let res: IteratorResult<InvocationEvent> | typeof DRAIN_TIMEOUT;
    try {
      res = await Promise.race([it.next(), timeout]);
    } catch (err) {
      // The adapter's stream THREW mid-iteration (e.g. a tool it cannot dispatch).
      // Keep the events already collected and record WHY as an error terminal,
      // rather than discarding everything — otherwise the failure reads as "no
      // events" and hides the real cause.
      out.push({ type: 'completion', outcome: 'error', reason: `stream threw: ${(err as Error).message}` });
      break;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res === DRAIN_TIMEOUT) {
      out.push({ type: 'completion', outcome: 'error', reason: 'certification_drain_timeout' });
      break;
    }
    if (res.done) break;
    out.push(res.value);
    if (out.length >= cap) {
      // Name the truncation. Cut silently, a capped drain is INDISTINGUISHABLE
      // from an engine that never terminates: no terminal, no usage, and three
      // checks failing as contract violations. Grok hit this — it streams fine
      // token deltas, passed `invoke_yields_events`, and failed everything that
      // reads the end of the stream.
      out.push({
        type: 'completion',
        outcome: 'error',
        reason: `certification_drain_cap_reached: stopped after ${cap} events before the engine terminated`,
      });
      break;
    }
    if (signal.aborted && out.some((e) => e.type === 'completion')) break;
  }
  return out;
}

const terminals = (evs: InvocationEvent[]): InvocationEvent[] => evs.filter((e) => e.type === 'completion');

/**
 * Certify a concrete engine, driven as a concrete provider, at the behavioral
 * contract level. Drives the adapter (the caller has armed a mocked or real
 * transport) and asserts the mandatory §7.2 categories against the CONSUMED
 * streams.
 */
export async function certifyEngine(
  engine: ExecutionEngineId,
  adapter: VendorSdkAdapter,
  opts: CertifyOptions = {},
): Promise<EngineCertificationResult> {
  const provider = opts.provider ?? defaultProbeProvider(engine);
  // The 30s deadline is the primary guard on a non-terminating adapter; this
  // caps MEMORY for a runaway stream. 500 was below what a token-delta engine
  // emits for an ordinary short answer, so the guard was firing on healthy runs.
  const cap = opts.maxEvents ?? 5_000;
  const checks: CertificationCheck[] = [];
  /** Run one check. `false` or a throw fails it; a STRING passes it and records
   *  that string as the reason — which is how a check that could not be
   *  exercised says so instead of being indistinguishable from one that ran and
   *  was satisfied. */
  const record = async (
    category: CertificationCategory,
    name: string,
    fn: () => boolean | void | string | Promise<boolean | void | string>,
  ): Promise<void> => {
    let passed = false;
    let detail: string | undefined;
    try {
      const r = await fn();
      passed = r !== false;
      if (typeof r === 'string') detail = r;
    } catch (err) {
      passed = false;
      detail = (err as Error).message;
    }
    checks.push({ category, name, passed, detail });
  };

  // Fully wire the adapter the way the runtime does.
  adapter.registerToolCatalog(minimalCatalog());
  adapter.registerHitlGate?.(async () => ({ allow: true }));
  adapter.registerAnomalyHandler?.(async () => ({ escalate: false }));

  // ── governed_tool_execution — the canonical catalog registers + round-trips. ──
  await record('governed_tool_execution', 'tool_catalog_round_trip', () => {
    const stored = (adapter as unknown as { catalog?: McpToolCatalog | null }).catalog;
    return !!stored && stored.tools.some((t) => t.name === 'probe_tool');
  });

  // The tool's ARGUMENTS survive registration on this engine.
  //
  // Separate from the round-trip check because they fail separately: the tool
  // arrived and its parameters did not, which is what happened on every
  // non-Anthropic engine for three months while the round-trip stayed green.
  //
  // This is also the provenance gate's precondition. The gate judges a write by
  // which argument names a record; an engine that drops arguments gives it
  // nothing to judge, and it reports success on every call.
  await record('governed_tool_execution', 'tool_arguments_survive_registration', () => {
    const stored = (adapter as unknown as { catalog?: McpToolCatalog | null }).catalog;
    const probe = stored?.tools.find((t) => t.name === 'probe_tool');
    if (!probe) return 'catalog did not round-trip; argument check not reached';
    const schema = probe.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    } | undefined;
    const props = schema?.properties ?? {};
    if (!Object.prototype.hasOwnProperty.call(props, PROBE_ARGS.required)) return false;
    if (!Object.prototype.hasOwnProperty.call(props, PROBE_ARGS.optional)) return false;
    // Required-ness is what makes an argument a record rather than a filter,
    // and it is dropped independently of the property itself.
    return Array.isArray(schema?.required) && schema.required.includes(PROBE_ARGS.required);
  });

  // The catalog reaches the MODEL, not only the adapter. The two checks above
  // read the adapter's own copy back; on the Gemini CLI that copy can be
  // intact while the model never sees a tool — the CLI's core allowlist can
  // withhold every MCP declaration from it — and every behavioural probe below
  // runs with an EMPTY catalog on purpose, so nothing here could see it. This drives one turn with the probe tool live and holds
  // the engine to calling it. Live only: the mocked suite's vendors never call
  // a tool, and a check that cannot be exercised is recorded as absent, not as
  // passed.
  if (opts.liveCatalog) {
    await record('governed_tool_execution', 'catalog_reaches_model', async () => {
      adapter.registerToolCatalog(liveProbeCatalog());
      const cc = new AbortController();
      const evs = await drain(adapter.invoke(catalogProbeInput(engine, provider), cc.signal), cc.signal, cap).catch(() => null);
      const called = (evs ?? [])
        .filter((e): e is Extract<InvocationEvent, { type: 'tool_call_started' }> => e.type === 'tool_call_started')
        .map((e) => e.toolName);
      if (called.some(namesProbeTool)) return true;
      // Name what the model did instead, so a refusal reads differently from
      // a model that was never shown the tool.
      const said = (evs ?? [])
        .filter((e): e is Extract<InvocationEvent, { type: 'assistant_message' }> => e.type === 'assistant_message')
        .flatMap((e) => e.content.map((c) => (c.type === 'text' ? c.text : '')))
        .join(' ')
        .slice(0, 200);
      const t = evs && terminals(evs)[0];
      const terminal = t && t.type === 'completion' ? `${t.outcome}${t.reason ? ` (${t.reason})` : ''}` : 'none';
      throw new Error(
        `the model never called probe_tool: tools called=${JSON.stringify(called)}; terminal=${terminal}; said=${JSON.stringify(said)}`,
      );
    });
  }

  // Re-register an EMPTY tool catalog for the behavioral invoke/resume probes.
  // Level 3 tests pure generation + termination + usage + pause/resume round-trip
  // (deep governed tool dispatch is certified at level 2 by the per-adapter fixture
  // suites). Leaving a callable tool in scope lets an EAGER model (e.g.
  // gemini-flash-lite) answer the probe with a functionCall that the live cert has
  // no executor to satisfy — the adapter then throws, which is a probe artifact,
  // not an engine defect. The tool_catalog_round_trip check above already exercised
  // the populated catalog.
  adapter.registerToolCatalog({ servers: [], tools: [] });

  // ── invocation_and_termination — DRIVE invoke() and consume the stream. ──
  const ac = new AbortController();
  const invokeEvents = await drain(adapter.invoke(probeInput(engine, provider), ac.signal), ac.signal, cap).catch(() => null);
  await record('invocation_and_termination', 'invoke_yields_events', () => Array.isArray(invokeEvents) && invokeEvents.length > 0);
  await record('invocation_and_termination', 'emits_exactly_one_terminal_completion', () => !!invokeEvents && terminals(invokeEvents).length === 1);
  await record('invocation_and_termination', 'terminal_is_the_final_event', () =>
    !!invokeEvents && invokeEvents.length > 0 && invokeEvents[invokeEvents.length - 1].type === 'completion');
  await record('invocation_and_termination', 'clean_stream_completes_success_not_empty', () => {
    const t = invokeEvents && terminals(invokeEvents)[0];
    if (t && t.type === 'completion' && t.outcome === 'success') return true;
    // Surface WHY this engine did not cleanly complete — carry the terminal's
    // outcome + reason (provider 404 / auth / rejected model / drain timeout)
    // into the check detail so the live-cert result names the real cause instead
    // of a bare "clean_stream failed".
    const detail = t && t.type === 'completion'
      ? `terminal outcome='${t.outcome}'${t.reason ? ` reason=${JSON.stringify(t.reason)}` : ''}`
      : 'no terminal completion event';
    throw new Error(detail);
  });

  // Abort actually INTERRUPTS: a pre-aborted invoke must not run to a clean
  // success. An adapter that ignores the signal and completes normally fails here
  // (that is the whole point — a runtime that can't be cancelled is not certified).
  await record('invocation_and_termination', 'honors_abort_signal', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const evs = await drain(adapter.invoke(probeInput(engine, provider), aborted.signal), aborted.signal, cap).catch(() => [] as InvocationEvent[]);
    return !evs.some((e) => e.type === 'completion' && e.outcome === 'success');
  });

  // An error terminal the ADAPTER produced must carry the provider's structured
  // failure, so the class persisted against the run can be checked against its
  // evidence rather than taken on trust.
  //
  // Vacuous at level 1, where the armed transport is a happy stream and there is
  // no error terminal to inspect — asserting on an absent event would be
  // theatre. It bites at level 3, against a real provider, and on any level-1
  // suite that arms a failing transport. Synthesized terminals (a drain timeout,
  // a stream that threw) are excluded: they are certification's own words, not
  // the engine's, and holding the engine to them would fail it for our bug.
  await record('invocation_and_termination', 'error_terminal_carries_provider_failure', () => {
    const adapterErrors = (invokeEvents ?? []).filter(
      (e): e is Extract<InvocationEvent, { type: 'completion' }> =>
        e.type === 'completion'
        && e.outcome === 'error'
        && e.reason !== 'certification_drain_timeout'
        && !(e.reason ?? '').startsWith('stream threw: ')
        && e.reason !== 'aborted',
    );
    for (const t of adapterErrors) {
      if (!t.failure?.kind) {
        throw new Error(`error terminal carried no provider failure (reason=${JSON.stringify(t.reason)})`);
      }
    }
    return true;
  });

  // ── usage_and_billing — a usage event is emitted with token counts. ──
  await record('usage_and_billing', 'emits_usage_with_tokens', () => {
    const usage = invokeEvents?.find((e): e is Extract<InvocationEvent, { type: 'usage' }> => e.type === 'usage');
    return !!usage && typeof usage.usage?.inputTokens === 'number';
  });

  // ── hitl_and_pause_resume — pause token round-trips + resume drives a stream. ──
  await record('hitl_and_pause_resume', 'pause_returns_serializable_token', async () => {
    (adapter as unknown as { currentInvocation?: InvocationInput }).currentInvocation = probeInput(engine, provider);
    const token = await adapter.pause('ask_user');
    return typeof token.adapterKind === 'string' && typeof token.serialized === 'string' && JSON.parse(token.serialized) != null;
  });
  await record('hitl_and_pause_resume', 'resume_yields_events_and_one_terminal', async () => {
    const token = { adapterKind: engine, serialized: JSON.stringify({ reason: 'ask_user', input: probeInput(engine, provider) }) };
    const rc = new AbortController();
    const evs = await drain(adapter.resume(token, { text: 'go' }, rc.signal), rc.signal, cap).catch(() => null);
    return !!evs && evs.length > 0 && terminals(evs).length === 1;
  });

  // ── sessions_and_state — the concrete engine id is recognized. ──
  await record('sessions_and_state', 'engine_id_recognized', () => engine !== 'unknown-legacy');

  // ── trajectories_and_auditability — the recorder tap is implemented. ──
  await record('trajectories_and_auditability', 'implements_trajectory_recorder', () =>
    typeof adapter.registerTrajectoryRecorder === 'function');

  // ── trajectory_fidelity — the canned raw stream maps to the EXACT canonical
  // block list. A mapper regression fails certification, and therefore the PR.
  // Engines with no mapper of their own (openrouter-openai-wire taps no
  // recorder; unknown-legacy is not a real engine) have no fixture and pass
  // vacuously — an ABSENT fixture must not read as a fidelity failure, but a
  // PRESENT one that no longer reproduces must.
  await record('trajectory_fidelity', 'canonical_mapping_reproduces_fixture', () => {
    const fixture = fidelityFixtureFor(engine);
    if (!fixture) return true;
    const verdict = fixtureReproduces(fixture);
    if (!verdict.ok) throw new Error(verdict.detail ?? 'fidelity fixture did not reproduce');
    return true;
  });

  // Cross-engine resume: take every OTHER engine's recorded conversation,
  // repair it for this one, and assert the inverse mapper yields a message list
  // this engine could be invoked with. Runs the shipped subset of the 7x7
  // matrix — an engine with no inverse mapper keeps today's cold start and is
  // skipped rather than failed.
  await record('trajectory_fidelity', 'cross_engine_resume', () => {
    if (!inverseMapperShipped(engine)) return true;
    for (const fixture of FIDELITY_FIXTURES) {
      if (fixture.engine === engine) continue;
      const repaired = repairForReplay(fixture.expected, {
        sourceEngine: fixture.engine,
        targetEngine: engine,
        targetSupportsImages: false,
      });
      const messages = canonicalToEngine(engine, repaired);
      if (!messages) throw new Error(`no inverse mapper output for ${fixture.engine} -> ${engine}`);
      for (const m of messages) {
        if (m.content.length === 0) {
          throw new Error(`${fixture.engine} -> ${engine} produced an empty message`);
        }
      }
      // Pairing survives the round trip: a rebuilt conversation with an
      // unanswered call is exactly what providers reject.
      const uses = new Set<string>();
      const results = new Set<string>();
      for (const m of messages) {
        for (const c of m.content) {
          if (c.type === 'tool_use') uses.add(c.callId);
          if (c.type === 'tool_result') results.add(c.callId);
        }
      }
      for (const id of uses) {
        if (!results.has(id)) {
          throw new Error(`${fixture.engine} -> ${engine} left tool call '${id}' unanswered`);
        }
      }

    }
    return true;
  });

  // CONTENT, not counts — and against a CONVERSATION rather than an output
  // mapping. Every check above counts things: messages, pairs, emptiness. A
  // rebuild can satisfy all of them and still be unusable, because what makes
  // it usable is whether the questions survived, not how many items moved.
  //
  // The canonical record shipped assistant-only for its first days. The
  // recorder taps adapter OUTPUT and nothing recorded the input, so a rebuilt
  // thread handed the next engine the agent's own answers with none of the
  // prompts. Asked what it had been told, the model said NO CONTEXT — the
  // honest answer to what it received. Counts matched the entire time: 2
  // messages in, 2 out.
  //
  // FIDELITY_FIXTURES cannot serve here: each certifies one engine's raw
  // output, so being assistant-only is CORRECT for them.
  await record('trajectory_fidelity', 'rebuild_preserves_the_conversation', () => {
    if (!inverseMapperShipped(engine)) return true;
    for (const sourceEngine of REBUILD_SOURCE_ENGINES) {
      if (sourceEngine === engine) continue;
      const repaired = repairForReplay(REBUILD_CONVERSATION_FIXTURE, {
        sourceEngine,
        targetEngine: engine,
        targetSupportsImages: false,
      });
      const messages = canonicalToEngine(engine, repaired);
      if (!messages) throw new Error(`no inverse mapper output for ${sourceEngine} -> ${engine}`);

      if (!messages.some((m) => m.role === 'user')) {
        throw new Error(
          `${sourceEngine} -> ${engine} rebuilt a conversation with NO user turn — `
          + 'half a conversation, and every count-based check above passes it',
        );
      }
      const userTurnsOut = messages.filter((m) => m.role === 'user').length;
      if (userTurnsOut < REBUILD_CONVERSATION_FACTS.userTurns) {
        throw new Error(
          `${sourceEngine} -> ${engine} dropped user turns `
          + `(${REBUILD_CONVERSATION_FACTS.userTurns} in the record, ${userTurnsOut} rebuilt)`,
        );
      }
      // The only thing that actually matters: can the next engine answer the
      // last question? It can only be answered from the user turns, so the
      // codewords are the load-bearing content and their absence is the defect
      // this check exists for.
      const rebuiltText = JSON.stringify(messages);
      for (const needle of REBUILD_CONVERSATION_FACTS.mustContain) {
        if (!rebuiltText.includes(needle)) {
          throw new Error(
            `${sourceEngine} -> ${engine} lost '${needle}' — it survives only in a user `
            + 'turn, so the rebuilt conversation cannot answer what was asked of it',
          );
        }
      }
    }
    return true;
  });

  // The other side of the seam: can the target engine actually READ what we
  // rebuilt for it? Every check above asserts on what `canonicalToEngine`
  // EMITS and stops there. A rebuilt conversation passed all of them and then
  // died inside the OpenAI SDK on `item.content.map is not a function`, because
  // the adapter's own translation produced an assistant item the SDK could not
  // parse. Both halves were tested; the join was not.
  //
  // Adapters that take history as a text preamble (Codex, opencode, ADK) have
  // no shape to get wrong and do not implement the probe — absent reads as
  // vacuous pass, the same convention as a missing fidelity fixture.
  await record('trajectory_fidelity', 'target_engine_accepts_rebuilt_history', () => {
    if (!inverseMapperShipped(engine)) return true;
    if (typeof adapter.assertCanReplayHistory !== 'function') {
      return 'engine replays history as a text preamble; no structured shape to verify';
    }
    for (const fixture of FIDELITY_FIXTURES) {
      if (fixture.engine === engine) continue;
      const repaired = repairForReplay(fixture.expected, {
        sourceEngine: fixture.engine,
        targetEngine: engine,
        targetSupportsImages: false,
      });
      const messages = canonicalToEngine(engine, repaired);
      if (!messages) continue;
      try {
        adapter.assertCanReplayHistory(messages);
      } catch (err) {
        throw new Error(
          `${fixture.engine} -> ${engine}: ${(err as Error).message}`,
        );
      }
    }
    return true;
  });

  // ── sdk_hook_contract — the vendor SDK still enforces what we enforce
  // through it. Every governance decision on this engine is expressed as a
  // throw, a deny, a result replacement, or a per-call decision, so if the SDK
  // stops honouring one of those, our gates become advisory with nothing in our
  // own repo differing.
  //
  // Only claude-agent-sdk has hooks; the rest have no such surface and pass
  // vacuously, the same way an engine with no fidelity fixture does.
  //
  // The probes drive the live API, so an environment without a credential
  // cannot run them. That records a pass with the reason attached rather than a
  // failure — a missing key is not a broken contract — and the job below
  // reports whether the contract was actually exercised, so a run that checked
  // nothing does not read as a run that checked everything.
  if (engine === 'claude-agent-sdk') {
    const unrunnable = hookContractUnrunnableReason();
    for (const probe of SDK_HOOK_CONTRACT_PROBES) {
      await record('sdk_hook_contract', probe.name, async () => {
        if (unrunnable) return `not exercised: ${unrunnable}`;
        await probe.run();
        return true;
      });
    }
  } else {
    await record('sdk_hook_contract', 'engine_has_no_hook_surface', () => true);
  }

  const passed = checks.every((c) => c.passed);
  return {
    engine,
    provider,
    runtimeVersion: opts.runtimeVersion ?? 'unknown',
    imageRevision: opts.imageRevision ?? 'unknown',
    contractVersion: CERTIFICATION_CONTRACT_VERSION,
    passed,
    checks: Object.fromEntries(checks.map((c) => [c.name, c.passed])),
    checkDetail: checks,
  };
}

/** Persist per-engine certification results as a CI artifact (JSON).
 * Promotion automation reads this to verify the engine + SDK/CLI version in the
 * built image has a passing result before an engine flag is flipped. Returns the
 * aggregate pass/fail so a runner can set its exit code. */
/** What a vendor says when the ACCOUNT cannot pay, as opposed to what the
 *  engine did with the request. Matched against each failed check's detail. */
const FUNDING_REFUSALS: readonly RegExp[] = [
  /credit balance is too low/i,          // Anthropic
  /\b402\b/,                              // Payment Required, any vendor
  /insufficient_quota|exceeded your current quota/i,   // OpenAI
  /no available [\w ]*credits/i,
  /insufficient (credits|funds|balance)/i,
];

/**
 * True when a failed engine failed ONLY because its vendor account is unfunded.
 *
 * Such a run says nothing about the SDK contract: the request was refused before
 * the engine's behaviour could be observed. Every failed check that carries a
 * reason must name a funding refusal; a check that failed with no reason (a
 * usage count that never arrived) is the refusal's consequence, not separate
 * evidence. One reason that is anything else, including a connection error,
 * keeps the run failed: "Connection error." has been our own fetch wrapper
 * breaking every request, which is exactly what this gate exists to stop.
 */
export function failedOnlyForFunding(result: EngineCertificationResult): boolean {
  if (result.passed) return false;
  const reasons = result.checkDetail.filter((c) => !c.passed && c.detail).map((c) => c.detail as string);
  return reasons.length > 0 && reasons.every((d) => FUNDING_REFUSALS.some((re) => re.test(d)));
}

/** The run's verdict, in the three states every gate in this repo uses: an
 *  inconclusive run blocks nothing and certifies nothing. */
export function certificationVerdict(results: readonly EngineCertificationResult[]): 'passed' | 'failed' | 'inconclusive' {
  if (results.length === 0) return 'failed';
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return 'passed';
  return failed.every(failedOnlyForFunding) ? 'inconclusive' : 'failed';
}

export function writeCertificationArtifact(results: EngineCertificationResult[], outPath: string): boolean {
  const allPassed = results.length > 0 && results.every((r) => r.passed);
  const artifact = {
    contractVersion: results[0]?.contractVersion ?? CERTIFICATION_CONTRACT_VERSION,
    allPassed,
    engines: results.map((r) => ({ engine: r.engine, provider: r.provider, passed: r.passed })),
    results,
  };
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return allPassed;
}
