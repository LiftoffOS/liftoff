// adapter/index.ts — public entry point for the VendorSdkAdapter package.
// See docs/adr/002-vendor-sdk-adapter-architecture.md for the contract.

import { AnthropicAdapter } from './anthropic';
import { OpenAiWireAdapter } from './openai-wire';
import { openAiTarget } from './openai';
import { openRouterTarget } from './openrouter';
import { GeminiAdapter } from './gemini';
import type { VendorSdkAdapter, ResolvedProvider, ExecutionEngineId } from './types';
import { resolveExecutionEngine } from './engine-resolver';

// The self-managing engines (Codex / ADK / opencode / Gemini CLI) are
// LAZY-loaded so their vendor SDKs (@openai/codex-sdk, @google/adk,
// @opencode-ai/sdk — ESM-only or ESM-dep-carrying) are pulled in ONLY when a
// run resolves to them, not at module init. Codex, opencode and the Gemini CLI
// are the DEFAULTS for OpenAI, xAI, the open-weights families and Google now,
// so on a service running any of those the load happens on the first such run
// rather than never; the lazy `require` still keeps the Anthropic-only load
// path unchanged and keeps ESM-only deps out of CommonJS test/tooling paths.

export type {
  VendorSdkAdapter,
  ResolvedProvider,
  InvocationInput,
  InvocationEvent,
  PlatformMessage,
  PlatformContent,
  PauseReason,
  ResumeToken,
  HitlGate,
  HitlGateResult,
  PauseGateContext,
  PendingHitlToolCall,
  AnomalyHandler,
  AnomalyKind,
  AnomalyContext,
  UserMessage,
  UserResponse,
  AdapterUsage,
  ByokAdapterCredential,
  ExecutionEngineId,
  NestedSpecialistEngineId,
} from './types';

export { resolveExecutionEngine } from './engine-resolver';

export type {
  McpServerConfig,
  McpToolDefinition,
  McpToolCatalog,
} from './catalog-types';

/** Construct the adapter for an already-resolved concrete engine. The
 * self-managing engines (Codex / ADK / opencode / Gemini CLI) keep their LAZY `require`
 * so their ESM-only SDKs load only when a run resolves to that engine,
 * preserving the Anthropic-only load path (see the module header).
 *
 *  Gemini runs on the official Google Gen AI SDK (`@google/genai`) over Vertex
 *  AI (ADC) — NOT Google ADK (its OTel-2.x deps conflict with the repo's
 *  pinned OTel-1.x stack). Requires Gemini 3.x (built-in + custom tools only
 *  coexist there) and Vertex env (GOOGLE_GENAI_USE_VERTEXAI /
 *  GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION). See adapter/gemini/index.ts. */
function constructAdapter(engineId: ExecutionEngineId): VendorSdkAdapter {
  switch (engineId) {
    case 'claude-agent-sdk':
      return new AnthropicAdapter();
    case 'openai-agents':
      return new OpenAiWireAdapter({ target: openAiTarget });
    case 'openai-codex': {
        const { CodexAdapter } = require('./codex') as typeof import('./codex');
        return new CodexAdapter();
      }
    case 'openrouter-openai-wire':
      return new OpenAiWireAdapter({ target: openRouterTarget });
    case 'xai-openai-wire': {
        const { createXaiAdapter } = require('./xai') as typeof import('./xai');
        return createXaiAdapter();
      }
    case 'opencode': {
        const { OpencodeAdapter } = require('./opencode') as typeof import('./opencode');
        return new OpencodeAdapter();
      }
    case 'google-genai':
      return new GeminiAdapter();
    case 'google-adk': {
        const { GeminiAdkAdapter } = require('./gemini-adk') as typeof import('./gemini-adk');
        return new GeminiAdkAdapter();
      }
    case 'google-gemini-cli': {
        const { GeminiCliAdapter } = require('./gemini-cli') as typeof import('./gemini-cli');
        return new GeminiCliAdapter();
      }
    case 'unknown-legacy':
      // Provenance-only sentinel for pre-migration rows; never constructable.
      throw new Error('unknown-legacy is not a constructable engine');
    default: {
      const _exhaustive: never = engineId;
      throw new Error(`Unknown engine: ${_exhaustive}`);
    }
  }
}

/** Construct the adapter for a NAMED engine, bypassing provider resolution.
 *
 *  `createAdapter` below takes a provider and resolves the engine from the env
 *  flags, which is right for execution — the deployment decides what runs. It is
 *  wrong for anything that must exercise a SPECIFIC engine regardless of what
 *  this environment happens to run: certification, and the canonical-rebuild
 *  canary, which asks whether each target engine could read a rebuilt
 *  conversation. */
export function constructAdapterForEngine(engineId: ExecutionEngineId): VendorSdkAdapter {
  return constructAdapter(engineId);
}

/** Adapter factory. Selection is purely a function of resolved provider (and the
 * engine env flags, via resolveExecutionEngine). Behavior is unchanged from the
 * pre-provenance version; construction now shares its resolution with
 * resolveAdapter() so the running adapter and recorded engine id cannot
 * disagree. */
export function createAdapter(provider: ResolvedProvider): VendorSdkAdapter {
  return constructAdapter(resolveExecutionEngine(provider, process.env));
}

/** Construct the adapter AND return the concrete engine id that was
 * resolved to build it, so callers persisting invocation provenance record the
 * exact engine that will execute. Uses the same resolution as createAdapter(). */
export function resolveAdapter(provider: ResolvedProvider): {
  adapter: VendorSdkAdapter;
  engineId: ExecutionEngineId;
} {
  const engineId = resolveExecutionEngine(provider, process.env);
  return { adapter: constructAdapter(engineId), engineId };
}
