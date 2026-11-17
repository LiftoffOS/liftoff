// Synthetic per-engine prompt-cache benchmark.
//
// WHY THIS EXISTS BEFORE ANY PREFIX WORK. The organic numbers cannot answer the
// question. Read per provider over sixty days they say anthropic 99.9%,
// openai-wire 39.7%, google 0% — but the three carry wildly different traffic
// (one engine serves almost everything, another serves five vendors, a third is
// barely chosen), so the spread measures the vendor mix rather than the caching.
// Read in aggregate they say "anthropic", because anthropic is nearly all of it.
// Neither reading tells you whether a change helped.
//
// So the measurement is CONSTRUCTED. The same three-turn conversation, the same
// system prompt, the same tool catalog, driven through every engine, reading the
// counters each provider reports back. Every engine sees identical work, which
// makes the numbers comparable across engines and — run again after a change —
// comparable across time. That second property is the point: this is a BASELINE,
// recorded before the prefix work, so an improvement is a difference rather than
// an assertion.
//
// WHAT IT MEASURES. Turn 1 is a cache WRITE and is expected to report no reads.
// Turns 2 and 3 are the measurement: the system prompt and turn 1's exchange are
// now a prefix the provider has seen, so a provider that caches should report
// most of the input as cached. `cacheReadRatio` is cached / (cached + fresh)
// over turns 2 and 3 only.
//
// WHY THE PROMPT IS LONG. No vendor caches a short prefix — Anthropic's floor is
// 1,024 tokens (2,048 on Haiku), OpenAI's automatic caching starts at 1,024, and
// Gemini's implicit caching needs 4,096 on the 3.x models. A benchmark under the
// floor reports zero everywhere and measures nothing but the floor. The system
// prompt below is padded past the highest of them so the number reflects the
// mechanism, and `systemPromptTokensApprox` is reported so a reader can see that
// it did clear them.
//
// NOT A GATE. A low ratio on an engine is a finding, not a failure: some
// providers do not cache at all on some paths, and that is exactly what the
// baseline is for. The script exits non-zero only when it could not measure.

import type {
  ExecutionEngineId,
  InvocationEvent,
  InvocationInput,
  McpToolCatalog,
  PlatformMessage,
  ResolvedProvider,
  VendorSdkAdapter,
} from '../adapter';
import { providerFamilyPairs, type EngineProviderPair } from '../adapter/vendors';
import { freshInputTokensFor } from '../../llm/pricing';
import type { LLMProvider } from '../../llm/types';

/** Every (engine, provider) pair a run can resolve to.
 *
 *  Derived, because the benchmark's whole claim is that it covers the estate —
 *  and a hand-written list quietly stops covering it the day an engine is
 *  added — and then reports every engine green while some were never
 *  exercised.
 *
 *  Per PAIR, from the same record the certification runner reads. Both kept
 *  their own one-provider-per-engine map, and this one was still wrong after
 *  that one was fixed: it gave the xAI engine `openrouter`, so the benchmark
 *  measured Grok's engine against OpenRouter's tier map — a model api.x.ai
 *  does not serve. And one provider per engine is one row short the moment an
 *  engine serves two configurations, which opencode does: Grok from xAI's
 *  account, the open-weights families from OpenRouter's. A cache ratio is a
 *  property of the provider's endpoint, so each is measured on its own.
 *
 *  Per provider FAMILY, not per transport pair. `engineProviderPairs` folds
 *  qwen, deepseek, kimi and minimax onto glm — right for a transport test,
 *  wrong here: a cache ratio depends on the model id and the provider's own
 *  cache rules (Qwen needs explicit breakpoints, GLM caches on its own), and
 *  a benchmark that ran the four as glm would report GLM's numbers as theirs.
 *  `providerFamilyPairs` is the matrix with no collapse, minus the documented
 *  exclusions (`PROVIDER_FAMILY_EXCLUSIONS`). */
export const BENCHMARK_PAIRS: readonly EngineProviderPair[] = providerFamilyPairs();

/**
 * The fixed system prompt. Deliberately long, deliberately boring, and
 * deliberately CONSTANT: the byte-stability of this string across turns is half
 * of what is being measured, so nothing per-run may enter it — no date, no
 * invocation id, no tenant.
 *
 * Built by repeating a paragraph rather than written out, because its CONTENT is
 * irrelevant to a cache and its LENGTH is not. Repetition is honest here: the
 * provider hashes bytes, and a reader can see at a glance that nothing varies.
 */
export function benchmarkSystemPrompt(): string {
  const paragraph = [
    'You are a benchmark agent. Answer in one short sentence and call no tools.',
    'This paragraph exists to give the request a prefix long enough for a provider',
    'to cache. It carries no instruction that changes between runs, and no value',
    'that changes between turns, because a prefix that moves is not a prefix.',
  ].join(' ');
  // ~28 tokens per repeat at four characters per token; 240 repeats clears the
  // highest vendor floor (Gemini 3.x at 4,096) several times over, so a zero in
  // the results is a fact about the provider rather than about this string.
  return Array.from({ length: 240 }, (_, i) => `[${i}] ${paragraph}`).join('\n');
}

/** The three turns. Short, so the answer costs little and the INPUT dominates —
 *  the input is what a cache acts on. */
export const BENCHMARK_TURNS: readonly string[] = [
  'Say the word "one" and nothing else.',
  'Say the word "two" and nothing else.',
  'Say the word "three" and nothing else.',
];

export interface TurnMeasurement {
  turn: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Set when the turn could not be driven. The turn still appears, at zero, so
   *  a partial run is visibly partial rather than quietly short. */
  error?: string;
}

export interface EngineMeasurement {
  engine: ExecutionEngineId;
  provider: ResolvedProvider;
  model: string;
  systemPromptTokensApprox: number;
  turns: TurnMeasurement[];
  /** cached / (cached + fresh) over turns 2 and 3. Null when those turns
   *  reported no input at all, which means the run failed rather than that the
   *  provider does not cache — the two must not read the same. */
  cacheReadRatio: number | null;
  error?: string;
}

export interface BenchmarkArtifact {
  recordedAt: string;
  imageRevision: string;
  systemPromptTokensApprox: number;
  turnCount: number;
  engines: EngineMeasurement[];
}

/** Four characters per token, the estimate every budget in this estate uses.
 *  Approximate on purpose: it is reported so a reader can confirm the prompt
 *  cleared the vendor floors, not to be billed against. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** No tools. The tool list is part of the cached prefix on every provider, so a
 *  catalog that differed between engines would make their numbers
 *  incomparable — and an empty one is identical everywhere by construction. */
function emptyCatalog(): McpToolCatalog {
  return { servers: [], tools: [] };
}

/**
 * Drain one adapter turn, summing the usage it reports.
 *
 * Usage arrives as events rather than as a return value, and an adapter may emit
 * several (one per model round). They are summed rather than last-wins: a turn
 * that took two rounds spent both, and reporting only the last would flatter any
 * engine that retries.
 */
async function runTurn(
  adapter: VendorSdkAdapter,
  input: InvocationInput,
  maxEvents: number,
): Promise<{ usage: TurnMeasurement; assistantText: string }> {
  const usage: TurnMeasurement = { turn: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let assistantText = '';
  let seen = 0;

  const controller = new AbortController();
  for await (const event of adapter.invoke(input, controller.signal) as AsyncIterable<InvocationEvent>) {
    if (++seen > maxEvents) {
      controller.abort();
      throw new Error(`adapter emitted more than ${maxEvents} events without terminating`);
    }
    if (event.type === 'usage') {
      usage.inputTokens += event.usage.inputTokens ?? 0;
      usage.cachedTokens += event.usage.cachedTokens ?? 0;
      usage.outputTokens += event.usage.outputTokens ?? 0;
      continue;
    }
    if (event.type === 'assistant_delta') {
      assistantText += event.text;
    }
  }

  return { usage, assistantText };
}

export interface BenchmarkOptions {
  /** Resolved model id for the engine under measurement. */
  model: string;
  /** The provider the engine is driven as — the pair under measurement. */
  provider: ResolvedProvider;
  tenantId?: string;
  maxEventsPerTurn?: number;
}

/**
 * Drive one engine, as one provider, through the three turns and report what
 * that provider said.
 *
 * The conversation is APPEND-ONLY and the system prompt is reused by reference:
 * every turn re-sends the same opening bytes followed by strictly more. That is
 * the shape a cache rewards, and building it any other way would measure a
 * conversation nobody has.
 */
export async function benchmarkEngine(
  engine: Exclude<ExecutionEngineId, 'unknown-legacy'>,
  adapter: VendorSdkAdapter,
  options: BenchmarkOptions,
): Promise<EngineMeasurement> {
  const systemPrompt = benchmarkSystemPrompt();
  const provider = options.provider;
  const measurement: EngineMeasurement = {
    engine,
    provider,
    model: options.model,
    systemPromptTokensApprox: approxTokens(systemPrompt),
    turns: [],
    cacheReadRatio: null,
  };

  await adapter.registerToolCatalog(emptyCatalog());

  const history: PlatformMessage[] = [];
  for (let i = 0; i < BENCHMARK_TURNS.length; i++) {
    history.push({ role: 'user', content: [{ type: 'text', text: BENCHMARK_TURNS[i] }] } as PlatformMessage);

    try {
      const { usage, assistantText } = await runTurn(
        adapter,
        {
          messages: [...history],
          systemPrompt,
          model: options.model,
          provider,
          tenantId: options.tenantId ?? 'cache-benchmark',
          invocationId: `cache-benchmark-${engine}-${provider}-turn-${i + 1}`,
          // Per PAIR, not per turn. The benchmark measures whether turn 2
          // reuses turn 1's prefix, so the three turns have to share a
          // prompt-cache lane — a per-turn identity would route each one
          // somewhere else and measure the routing instead of the caching.
          agentId: `cache-benchmark-${engine}-${provider}`,
          maxTurns: 1,
          purpose: 'cache_benchmark',
        },
        options.maxEventsPerTurn ?? 500,
      );
      usage.turn = i + 1;
      measurement.turns.push(usage);
      // The assistant's own turn joins the history, or turn 3 would re-send
      // turn 2's prefix with a gap in it and cache nothing.
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: assistantText || '(no text)' }],
      } as PlatformMessage);
    } catch (err) {
      measurement.turns.push({
        turn: i + 1,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        error: (err as Error).message,
      });
      // A failed turn makes every later turn's prefix meaningless, so stop.
      measurement.error = `turn ${i + 1}: ${(err as Error).message}`;
      break;
    }
  }

  measurement.cacheReadRatio = computeCacheReadRatio(measurement.turns, provider);
  return measurement;
}

/**
 * cached / (cached + fresh) over the MEASUREMENT turns only.
 *
 * Turn 1 is excluded because it is the write. Including it would drag every
 * engine's number toward zero by construction and make a three-turn run look
 * worse than a thirty-turn one for no reason a reader could act on.
 *
 * Fresh is read by the provider's own accounting, through the same rule the
 * billing uses: Anthropic's `input_tokens` excludes the cached portion, every
 * other provider's prompt count includes it. Treating the inclusive count as
 * fresh halves every OpenAI-wire, Gemini and Codex row — a turn that re-read
 * nearly its whole prompt scores about 0.5 — while the Anthropic row scores
 * nearly 1 for the same behaviour, and the matrix reads as a difference between vendors
 * that is a difference between counters.
 */
export function computeCacheReadRatio(turns: readonly TurnMeasurement[], provider: string): number | null {
  const measured = turns.filter((t) => t.turn > 1 && !t.error);
  if (measured.length === 0) return null;
  const cached = measured.reduce((sum, t) => sum + t.cachedTokens, 0);
  const fresh = measured.reduce((sum, t) => sum + freshInputTokensFor(provider as LLMProvider, t.inputTokens, t.cachedTokens), 0);
  const total = cached + fresh;
  // No input reported at all is a broken measurement, not a provider that does
  // not cache. Null keeps the two apart; 0 would claim a finding we do not have.
  if (total === 0) return null;
  return cached / total;
}
