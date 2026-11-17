// The vendor record is the single declaration of every vendor. This is what
// keeps it single.
//
// Deriving the provider list, the engine list and the resolver from one record
// removes the drift that caused most of the Grok defects — but two seams remain
// that a type system cannot close, and both are the kind that fail silently:
//
//   1. `ExecutionEngineId` is a hand-written UNION, because deriving it from the
//      record would widen it to `string` and accept any misspelling. The
//      compiler now enforces one direction — a vendor cannot name an engine
//      outside the union — but not the other: an engine can sit in the union
//      that no vendor reaches.
//   2. A vendor can be declared with no adapter able to construct it, which
//      compiles and then throws at the first run on that provider.
//
// Both are checked here, against the record rather than against a list written
// beside it.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  VENDORS, VENDOR_ENGINE_IDS, UNKNOWN_ENGINE, OPEN_WEIGHTS_ENGINE,
  engineProviderPairs, pairsForEngine,
} from '../vendors';
import { GATEWAY_SERVED_FAMILIES, isGatewayServed } from '../model-family';
import {
  RESOLVED_PROVIDERS,
  RESOLVABLE_EXECUTION_ENGINE_IDS,
  isResolvedProvider,
} from '../types';

/** Every engine id that exists, sentinel included. Composed here rather than
 *  exported: no production code wants the whole set — the resolvable ones drive
 *  the boot check, and the sentinel is only ever read back off a row. */
const ALL_ENGINE_IDS = [...VENDOR_ENGINE_IDS, UNKNOWN_ENGINE];
import { resolveExecutionEngine } from '../engine-resolver';

describe('the vendor record is the only place a vendor is declared', () => {
  it('declares at least the vendors we know we run', () => {
    // Guards the derivation itself: everything below reads from this record, so
    // an empty or broken one would make the rest pass vacuously.
    expect(Object.keys(VENDORS).sort()).toEqual([
      'anthropic', 'deepseek', 'glm', 'google', 'kimi',
      'minimax', 'openai', 'qwen', 'xai', 'xiaomi',
    ]);
  });

  it('is where the provider list comes from', () => {
    expect([...RESOLVED_PROVIDERS].sort()).toEqual(Object.keys(VENDORS).sort());
  });

  it('names each vendor consistently with its own key', () => {
    // The key IS the provider id written to `invocations.provider`. A record
    // whose key and `provider` disagree would resolve one and record the other.
    for (const [key, spec] of Object.entries(VENDORS)) {
      expect(spec.provider).toBe(key);
    }
  });

  it('every provider is recognised at run time', () => {
    for (const p of Object.keys(VENDORS)) expect(isResolvedProvider(p)).toBe(true);
  });
});

// THE PAIRING, pinned as a table. A vendor family is its models AND its
// runtime, chosen at the workspace with a per-agent override — both surfaces
// already exist for the vendor, so no field is added anywhere: the engine
// follows from the provider. The wire bridges and ADK are the escape hatches,
// selectable by operator flags that survive deploys. Written out here on
// purpose, because a derived assertion would pass whatever the record said.
describe('a vendor family is its models and its runtime', () => {
  it.each([
    ['anthropic', 'claude-agent-sdk', undefined, undefined],
    ['openai', 'openai-codex', 'OPENAI_ENGINE', { agents: 'openai-agents' }],
    ['xai', 'opencode', 'XAI_ENGINE', { wire: 'xai-openai-wire' }],
    ['glm', 'opencode', 'OPENROUTER_ENGINE', { wire: 'openrouter-openai-wire' }],
    ['qwen', 'opencode', 'OPENROUTER_ENGINE', { wire: 'openrouter-openai-wire' }],
    ['deepseek', 'opencode', 'OPENROUTER_ENGINE', { wire: 'openrouter-openai-wire' }],
    ['kimi', 'opencode', 'OPENROUTER_ENGINE', { wire: 'openrouter-openai-wire' }],
    ['minimax', 'opencode', 'OPENROUTER_ENGINE', { wire: 'openrouter-openai-wire' }],
    ['google', 'google-gemini-cli', 'GOOGLE_ENGINE', { genai: 'google-genai', adk: 'google-adk' }],
  ] as const)('%s runs on %s, escape hatch %s=%o', (provider, engine, envVar, alternatives) => {
    const spec = VENDORS[provider].engine as { default: string; envVar?: string; alternatives?: Record<string, string> };
    expect(spec.default).toBe(engine);
    expect(spec.envVar).toBe(envVar);
    expect(spec.alternatives).toEqual(alternatives);
  });

  it('gives Grok a flag of its own, separate from the gateway\'s', () => {
    // The gateway's flag moves the gateway's families together; Grok shares
    // the engine and not the transport, so it must not move with them.
    expect(VENDORS.xai.engine).not.toBe(OPEN_WEIGHTS_ENGINE);
    expect(VENDORS.xai.engine.envVar).not.toBe(OPEN_WEIGHTS_ENGINE.envVar);
  });

  it('keeps the open-weights families on ONE shared engine record', () => {
    for (const family of ['glm', 'qwen', 'deepseek', 'kimi', 'minimax'] as const) {
      expect(VENDORS[family].engine).toBe(OPEN_WEIGHTS_ENGINE);
    }
  });
});

// The gateway-served set is derived from the shared record's IDENTITY. It used
// to be derived from the engine id, and that stopped distinguishing anything
// the day Grok moved onto the same engine from its own account: keyed on the
// id, every family or none would have read as gateway-served — and the pricing
// derivation, the Grok-under-a-gateway-name redirect and the coding-CLI
// collapse all read this set.
describe('the gateway-served families survive the engine flip', () => {
  it('names exactly the six open-weights families', () => {
    expect([...GATEWAY_SERVED_FAMILIES].sort())
      .toEqual(['deepseek', 'glm', 'kimi', 'minimax', 'qwen', 'xiaomi']);
  });

  it('does not name Grok, which shares the engine and not the transport', () => {
    expect(isGatewayServed('xai')).toBe(false);
    expect(isGatewayServed('openai')).toBe(false);
    expect(isGatewayServed('glm')).toBe(true);
  });
});

// Every (engine, provider) configuration a run can land on, for the callers
// that exercise an engine per configuration: certification and the cache
// benchmark. One provider per engine was one row short the moment an engine
// served two.
describe('the (engine, provider) pairs', () => {
  const pairs = engineProviderPairs();

  it('drive opencode from BOTH accounts it serves', () => {
    expect(pairsForEngine('opencode').map((p) => p.provider).sort()).toEqual(['glm', 'xai']);
  });

  it('drive Codex as OpenAI, and each wire engine as its own provider', () => {
    expect(pairsForEngine('openai-codex').map((p) => p.provider)).toEqual(['openai']);
    expect(pairsForEngine('openai-agents').map((p) => p.provider)).toEqual(['openai']);
    expect(pairsForEngine('xai-openai-wire').map((p) => p.provider)).toEqual(['xai']);
    expect(pairsForEngine('openrouter-openai-wire').map((p) => p.provider)).toEqual(['glm']);
    expect(pairsForEngine('google-gemini-cli').map((p) => p.provider)).toEqual(['google']);
    expect(pairsForEngine('google-genai').map((p) => p.provider)).toEqual(['google']);
    expect(pairsForEngine('google-adk').map((p) => p.provider)).toEqual(['google']);
  });

  it('collapse the gateway families to one', () => {
    // The five families are one configuration of the gateway with different
    // model ids. claude-agent-sdk has a single provider now that Claude over
    // Google Vertex is retired — it used to be collapsed onto anthropic here.
    expect(pairsForEngine('claude-agent-sdk').map((p) => p.provider)).toEqual(['anthropic']);
    expect(pairs.filter((p) => ['qwen', 'deepseek', 'kimi', 'minimax'].includes(p.provider))).toEqual([]);
  });

  it('cover every resolvable engine, and nothing else', () => {
    expect([...new Set(pairs.map((p) => p.engine))].sort()).toEqual([...RESOLVABLE_EXECUTION_ENGINE_IDS].sort());
  });

  it('name no pair twice', () => {
    const keys = pairs.map((p) => `${p.engine}+${p.provider}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('every engine the record can reach is a real engine id', () => {
  it('has no engine in the union that no vendor can reach', () => {
    // The OTHER direction. The compiler already enforces that every engine a
    // vendor names is in the union — `VendorEngine.default` is typed as it — so
    // the gap this leaves is an engine in the union that nothing resolves to:
    // dead provenance, an adapter case nothing calls, and a value the SQL
    // constraints still have to carry.
    //
    // Listed rather than derived, because "orphaned" is a judgement about intent
    // that only a person can make. An engine that becomes unreachable should be
    // deleted or explained here, not quietly tolerated.
    const KNOWINGLY_UNREACHABLE = new Set([
      // Provenance for rows written before engines were recorded. Belongs to no
      // vendor by definition and must never be resolved TO.
      UNKNOWN_ENGINE,
    ]);
    const reachable = new Set<string>(VENDOR_ENGINE_IDS);
    const orphaned = ALL_ENGINE_IDS
      .filter((e) => !reachable.has(e) && !KNOWINGLY_UNREACHABLE.has(e));
    expect(orphaned).toEqual([]);
  });

  it('excludes the provenance sentinel from the resolvable set', () => {
    // `unknown-legacy` belongs to no vendor and must never be resolved TO.
    expect(RESOLVABLE_EXECUTION_ENGINE_IDS).not.toContain(UNKNOWN_ENGINE);
    expect(ALL_ENGINE_IDS).toContain(UNKNOWN_ENGINE);
  });

  it('resolves every vendor to an engine the union knows', () => {
    for (const p of Object.keys(VENDORS)) {
      const engine = resolveExecutionEngine(p as never, {} as NodeJS.ProcessEnv);
      expect(ALL_ENGINE_IDS).toContain(engine);
      expect(engine).not.toBe(UNKNOWN_ENGINE);
    }
  });

  it('reaches every alternative engine through its own env flag', () => {
    // An alternative nothing can select is an engine that exists on paper. Each
    // is exercised through the flag that selects it, so a renamed env var fails
    // here rather than silently pinning a provider to its default forever.
    for (const [name, spec] of Object.entries(VENDORS)) {
      const { envVar, alternatives } = spec.engine as {
        envVar?: string; alternatives?: Record<string, string>;
      };
      if (!envVar || !alternatives) continue;
      for (const [value, engine] of Object.entries(alternatives)) {
        const resolved = resolveExecutionEngine(
          name as never,
          { [envVar]: value } as unknown as NodeJS.ProcessEnv,
        );
        expect(resolved).toBe(engine);
      }
    }
  });

  it('falls back to the default when the flag is unset or unrecognised', () => {
    for (const [name, spec] of Object.entries(VENDORS)) {
      const { envVar, default: fallback } = spec.engine as { envVar?: string; default: string };
      expect(resolveExecutionEngine(name as never, {} as NodeJS.ProcessEnv)).toBe(fallback);
      if (envVar) {
        const nonsense = { [envVar]: 'not-an-engine' } as unknown as NodeJS.ProcessEnv;
        expect(resolveExecutionEngine(name as never, nonsense)).toBe(fallback);
      }
    }
  });
});

describe('every declared vendor can actually be constructed', () => {
  // Seam 2. A vendor in the record with no case in the adapter factory
  // compiles, ships, and throws on the first run that resolves to it.
  //
  // Read from SOURCE rather than by calling the factory: it requires the
  // ESM-only vendor SDKs (@openai/codex-sdk, @google/adk, @opencode-ai/sdk),
  // which jest cannot parse — the same reason engine-resolver.ts is kept free
  // of adapter imports. The property is still a property of the code, and this
  // is the cheapest place that can state it.
  const factory = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

  it('reads the factory it is checking', () => {
    expect(factory).toMatch(/function constructAdapter/);
  });

  it.each([...VENDOR_ENGINE_IDS])('%s has a case in the adapter factory', (engine) => {
    // Every engine any vendor can resolve to — defaults AND the alternatives a
    // deployment flag can select, since a flag pointing at an engine the
    // factory does not build fails only once that flag is set.
    expect(factory).toContain(`case '${engine}':`);
  });
});
