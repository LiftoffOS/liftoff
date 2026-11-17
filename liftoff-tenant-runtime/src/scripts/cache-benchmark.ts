// Record the per-engine prompt-cache baseline against the REAL vendor SDKs.
//
// The measurement and its reasoning live in
// agent-execution/cache-benchmark/benchmark.ts; this file is the runner: it
// constructs each engine's adapter the way the service does, drives the fixed
// three-turn conversation through it, and writes the artifact.
//
// Run on dev, before the prefix work, and again after it. The artifact is the
// baseline; the second run is the evidence.
//
//   node dist/scripts/cache-benchmark.js
//
// Env:
//   CACHE_BENCHMARK_OUTPUT  output path (default ./cache-benchmark.json)
//   BENCHMARK_ENGINES       optional comma-list to narrow the set
//   IMAGE_REVISION|SHORT_SHA  revision stamped into the artifact
//   CACHE_BENCHMARK_STRICT  '1' to exit non-zero if ANY engine failed to run
//
// Costs real money on real providers: three short turns per engine against a
// ~7k-token prompt. That is the price of a number that means something.

import { writeFileSync } from 'fs';
import type { ExecutionEngineId, VendorSdkAdapter } from '../agent-execution/adapter';
import {
  BENCHMARK_PAIRS,
  BENCHMARK_TURNS,
  approxTokens,
  benchmarkEngine,
  benchmarkSystemPrompt,
  type BenchmarkArtifact,
  type EngineMeasurement,
} from '../agent-execution/cache-benchmark/benchmark';
import type { EngineProviderPair } from '../agent-execution/adapter/vendors';
import { resolveModelForTier } from '../llm/tiers';

type BenchmarkEngine = Exclude<ExecutionEngineId, 'unknown-legacy'>;

/** Construct the concrete adapter using the SAME path the running service uses,
 *  so the lazy vendor SDK loads happen in the real runtime. Mirrors
 *  certify-engines.ts deliberately: two runners that construct engines
 *  differently would be measuring two different things. */
async function makeAdapter(engine: BenchmarkEngine): Promise<VendorSdkAdapter> {
  switch (engine) {
    case 'claude-agent-sdk':
      return new (await import('../agent-execution/adapter/anthropic')).AnthropicAdapter();
    case 'openai-agents':
      return new (await import('../agent-execution/adapter/openai-wire')).OpenAiWireAdapter(
        { target: (await import('../agent-execution/adapter/openai')).openAiTarget },
      );
    case 'openai-codex':
      return new (await import('../agent-execution/adapter/codex')).CodexAdapter();
    case 'google-genai':
      return new (await import('../agent-execution/adapter/gemini')).GeminiAdapter();
    case 'google-adk':
      return new (await import('../agent-execution/adapter/gemini-adk')).GeminiAdkAdapter();
    case 'google-gemini-cli':
      return new (await import('../agent-execution/adapter/gemini-cli')).GeminiCliAdapter();
    case 'openrouter-openai-wire':
      return new (await import('../agent-execution/adapter/openai-wire')).OpenAiWireAdapter(
        { target: (await import('../agent-execution/adapter/openrouter')).openRouterTarget },
      );
    case 'xai-openai-wire':
      return (await import('../agent-execution/adapter/xai')).createXaiAdapter();
    case 'opencode':
      return new (await import('../agent-execution/adapter/opencode')).OpencodeAdapter();
  }
}

/** Every pair, or the pairs on the engines BENCHMARK_ENGINES names. */
function pairsToRun(): readonly EngineProviderPair[] {
  const raw = (process.env.BENCHMARK_ENGINES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return BENCHMARK_PAIRS;
  return BENCHMARK_PAIRS.filter((p) => raw.includes(p.engine));
}

/** One structured line per engine, so a log-based metric can chart the baseline
 *  over time without anybody re-reading the artifact by hand. */
function emitResultLog(m: EngineMeasurement): void {
  // eslint-disable-next-line r5/no-console-in-src -- CLI batch job: stdout JSON IS the log-based-metric payload
  console.log(JSON.stringify({
    event: 'engine_cache_benchmark',
    metric_name: 'engine_cache_read_ratio',
    metric_kind: 'gauge',
    // Null (could not measure) is NOT zero (measured, no caching). Reported as
    // -1 so a chart cannot silently average the two together.
    metric_value: m.cacheReadRatio ?? -1,
    execution_engine: m.engine,
    provider: m.provider,
    model: m.model,
    outcome: m.error ? 'failed' : 'measured',
    system_prompt_tokens_approx: m.systemPromptTokensApprox,
    turns: m.turns,
    error: m.error,
  }));
}

function formatRatio(r: number | null): string {
  return r === null ? '  (not measured)' : `${(r * 100).toFixed(1).padStart(6)}%`;
}

async function main(): Promise<void> {
  // Hydrate provider secrets exactly as index.ts does at boot, so every engine
  // authenticates the way it does in production rather than reporting a
  // spurious auth failure as a cache finding.
  const { loadSecretsToEnv } = await import('../infrastructure/secrets');
  await loadSecretsToEnv();

  const pairs = pairsToRun();
  const measurements: EngineMeasurement[] = [];

  for (const { engine, provider } of pairs) {
    let measurement: EngineMeasurement;
    try {
      // A fresh adapter per pair: the three turns register on it.
      const adapter = await makeAdapter(engine);
      // The MEDIUM tier on every pair. Comparing a large model on one against a
      // small model on another would report the models, not the caching — and
      // the small tier carries the higher cache floor on Anthropic, which would
      // put one engine under a bar the others clear.
      const model = resolveModelForTier(provider, 'medium');
      measurement = await benchmarkEngine(engine, adapter, { model, provider });
    } catch (err) {
      measurement = {
        engine,
        provider,
        model: 'unknown',
        systemPromptTokensApprox: approxTokens(benchmarkSystemPrompt()),
        turns: [],
        cacheReadRatio: null,
        error: `could not construct or resolve: ${(err as Error).message}`,
      };
    }
    measurements.push(measurement);
    emitResultLog(measurement);
  }

  const artifact: BenchmarkArtifact = {
    recordedAt: new Date().toISOString(),
    imageRevision: process.env.IMAGE_REVISION ?? process.env.SHORT_SHA ?? 'unknown',
    systemPromptTokensApprox: approxTokens(benchmarkSystemPrompt()),
    turnCount: BENCHMARK_TURNS.length,
    engines: measurements,
  };

  const output = process.env.CACHE_BENCHMARK_OUTPUT ?? './cache-benchmark.json';
  writeFileSync(output, JSON.stringify(artifact, null, 2));

  // eslint-disable-next-line r5/no-console-in-src -- CLI batch job: the operator reads this
  console.log(
    `\ncache-read ratio, turns 2-3 (prompt ~${artifact.systemPromptTokensApprox} tokens):\n`
    + measurements
      .map((m) => `  ${`${m.engine} as ${m.provider}`.padEnd(36)} ${formatRatio(m.cacheReadRatio)}${m.error ? `  ${m.error}` : ''}`)
      .join('\n')
    + `\n\nwritten to ${output}\n`,
  );

  const failed = measurements.filter((m) => m.error);
  if (failed.length === measurements.length) {
    // Nothing was measured. That is a broken run, not a baseline of zero.
    // eslint-disable-next-line r5/no-console-in-src -- CLI batch job
    console.error('every engine failed — no baseline was recorded');
    process.exit(1);
  }
  if (failed.length > 0 && process.env.CACHE_BENCHMARK_STRICT === '1') {
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line r5/no-console-in-src -- CLI batch job
  console.error('cache-benchmark failed:', err);
  process.exit(1);
});
