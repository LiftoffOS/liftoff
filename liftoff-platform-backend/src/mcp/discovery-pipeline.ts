// Generic MCP discovery pipeline (5-stage orchestrator).
// Phase 0 extraction: factored from src/external-agents/discover-service.ts.
//
// Consumers (external_agents, custom_mcp_servers) call into this pipeline via
// thin adapters (discover-adapter.ts) that handle their own persistence shape.
// No external-agent fields live in this module.

import { MCPClient, type MCPClientConfig, type MCPDiscoveryResult } from './client';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';
import { analyzeCapabilities } from './capability-analyzer';
import {
  hashDescription,
  toolClassifier,
  type CachedClassification,
  type SensitivityCategory,
  type StoredEffectClass,
} from './tool-classifier';
import { isTypeSafeClassifierEnabled } from '../typesafe/flags';
import { CLASSIFICATION_VERSION } from '../typesafe/questions';
import type {
  AuthType,
  CustomHeader,
  DiscoverOutput,
  DiscoverStage,
} from './types';
import { log } from '../infrastructure/logging';
import { screenToolDefinitions } from '../injection-detection/gating';

export type { DiscoverStage };

export type ProgressCallback = (stage: DiscoverStage) => void;

/**
 * Optional persistence callback invoked at the finalizing stage. Consumers
 * (external agents / custom MCP servers) write the discovered result into
 * their own table.
 */
export type PersistenceCallback<T> = (output: DiscoverOutput) => Promise<T>;

/** A tool's cached classification, looked up by the adapter that owns the
 *  source's identity. Only the adapter knows how the service layer keys its
 *  writes (`custom_mcp_server:<id>` per tool name; `<agent id>:<name>` under
 *  `external-agent`), so the pipeline is handed a reader and never a key. */
export type ClassificationLookup = (tool: { name: string; description: string }) => Promise<CachedClassification | null>;

export interface DiscoveryPipelineInput {
  endpointUrl: string;
  name: string;
  description?: string;
  authType: AuthType;
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: CustomHeader[];
  tenantId?: string;
  agentId?: string;
  correlationId?: string;
  /** Supplied on a rediscovery by the adapter that owns the identity. A
   *  cached row is reused when it is a manual override, or when its
   *  description hash matches and its classification version is current;
   *  everything else is classified. A throwing lookup is a miss. The
   *  pipeline never writes the cache — the service layer stays the one
   *  writer per source, so the manual-override protection in its upsert
   *  keeps applying. First discovery supplies no lookup and classifies
   *  everything. */
  classificationLookup?: ClassificationLookup;
}

/** Whether a cached row stands in for a classification of this description. */
export function cachedClassificationIsCurrent(
  cached: CachedClassification,
  description: string,
): boolean {
  if (cached.isManualOverride) return true;
  if (cached.toolDescriptionHash !== hashDescription(description)) return false;
  // A row older than the current classification version (or from before
  // versions were recorded) is re-classified so it gains the effect head.
  return (cached.classificationVersion ?? 0) >= CLASSIFICATION_VERSION;
}

export async function runDiscoveryPipeline(
  input: DiscoveryPipelineInput,
  onProgress: ProgressCallback,
): Promise<DiscoverOutput>;
export async function runDiscoveryPipeline<T>(
  input: DiscoveryPipelineInput,
  onProgress: ProgressCallback,
  persist: PersistenceCallback<T>,
): Promise<{ output: DiscoverOutput; persisted: T }>;
export async function runDiscoveryPipeline<T>(
  input: DiscoveryPipelineInput,
  onProgress: ProgressCallback,
  persist?: PersistenceCallback<T>,
): Promise<DiscoverOutput | { output: DiscoverOutput; persisted: T }> {
  // Stage 1: Validating input
  onProgress('validating');

  if (!input.endpointUrl || !input.name) {
    throw new Error('Endpoint URL and name are required');
  }

  // E1: this is the one place every MCP discovery funnels through — custom
  // servers AND external agents — and the next line opens a real connection to
  // whatever it is handed. A format check was never enough.
  try {
    await assertPublicUrl(input.endpointUrl, { context: 'mcp.discovery-pipeline' });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      throw new Error('That endpoint address is not reachable from Liftoff. Use a public https address.');
    }
    throw new Error('Invalid endpoint URL format');
  }

  // Stage 2: Discovering — connect to MCP server, fetch tools/resources
  onProgress('discovering');

  const mcpConfig: MCPClientConfig = {
    endpointUrl: input.endpointUrl,
    authType: input.authType,
    apiKey: input.apiKey,
    bearerToken: input.bearerToken,
    customHeaders: input.customHeaders,
    timeout: 30000,
  };

  const mcpClient = new MCPClient(mcpConfig);

  let mcpResult: MCPDiscoveryResult;
  try {
    mcpResult = await mcpClient.discover();
  } catch (error) {
    // Schema issues no longer reject the whole server — discover() now
    // classifies non-conforming tools as `degraded` and onboards the rest
    // (see classifyMcpTools). The errors reaching here are genuine transport /
    // protocol / connectivity failures.
    log.error({ error, endpoint: input.endpointUrl }, 'MCP discovery failed');
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
      throw new Error('Could not connect to MCP server. Check the URL and try again.');
    }
    if (message.includes('Authentication failed')) {
      throw new Error('Authentication failed. Check your credentials.');
    }
    if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      throw new Error('Connection timed out after 30 seconds.');
    }
    if (message.includes('MCP error')) {
      throw new Error("Endpoint responded but doesn't speak MCP protocol.");
    }

    throw new Error(`Failed to connect to MCP server: ${message}`);
  }

  log.info(
    {
      endpoint: input.endpointUrl,
      serverName: mcpResult.serverName,
      toolCount: mcpResult.tools.length,
      resourceCount: mcpResult.resources.length,
      transportType: mcpResult.transportType,
    },
    'MCP discovery successful',
  );

  if (mcpResult.tools.length === 0) {
    throw new Error('Connected but server has no tools defined.');
  }

  // Stage 3: Analyzing capabilities with LLM
  onProgress('analyzing');

  const analysis = await analyzeCapabilities({
    tools: mcpResult.tools,
    resources: mcpResult.resources,
    agentName: input.name,
    description: input.description || '',
    tenantId: input.tenantId,
    agentId: input.agentId,
    correlationId: input.correlationId,
  });

  // Stage 4: Classifying tools for HITL enforcement
  onProgress('classifying');

  const toolClassifications: Record<string, SensitivityCategory[]> = {};
  const toolEffectClasses: Record<string, StoredEffectClass> = {};
  const toolClassificationVersions: Record<string, number> = {};
  let reused = 0;

  for (const tool of mcpResult.tools) {
    const description = tool.description || '';
    if (input.classificationLookup) {
      let cached: CachedClassification | null = null;
      try {
        cached = await input.classificationLookup({ name: tool.name, description });
      } catch (err) {
        // A failing lookup is a miss: the tool is classified as on a first
        // discovery. The lookup exists to save a request, not to gate one.
        log.warn({ err: (err as Error).message, toolName: tool.name }, 'classification lookup failed; classifying');
      }
      if (cached && cachedClassificationIsCurrent(cached, description)) {
        toolClassifications[tool.name] = cached.categories;
        if (cached.effectClass && isTypeSafeClassifierEnabled()) toolEffectClasses[tool.name] = cached.effectClass;
        if (cached.classificationVersion !== null) toolClassificationVersions[tool.name] = cached.classificationVersion;
        reused += 1;
        continue;
      }
    }
    const classified = await toolClassifier.classifyTool(
      { name: tool.name, description },
      { purpose: 'tool_classification', ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
    );
    toolClassifications[tool.name] = classified.categories;
    if (classified.effectClass) toolEffectClasses[tool.name] = classified.effectClass;
    if (classified.by === 'jev') toolClassificationVersions[tool.name] = CLASSIFICATION_VERSION;
  }

  log.info(
    {
      endpoint: input.endpointUrl,
      toolsClassified: Object.keys(toolClassifications).length - reused,
      toolsReusedFromCache: reused,
      toolsWithEffectClass: Object.keys(toolEffectClasses).length,
    },
    'Tool classification complete',
  );

  // Injection scan of tool metadata — flag, never reject; per-tenant gated,
  // shadow-first. Runs at discovery AND rediscover (both go through this
  // pipeline); surfaces operator-visible flags on the result in enforce mode.
  const injectionFindings = await screenToolDefinitions(mcpResult.tools, input.tenantId);

  // Stage 5: Finalizing — pluggable persistence callback (if provided)
  onProgress('finalizing');

  const output: DiscoverOutput = {
    capabilities: analysis.capabilities,
    resources: analysis.resources,
    toolClassifications,
    // 1b: the confident effect class per tool, omitted for a tool with none.
    toolEffectClasses,
    toolClassificationVersions,
    // Persist ALL discovered tools (degraded ones annotated inline by
    // discover() so the runtime can exclude them from the LLM-facing set).
    rawMcpTools: mcpResult.tools,
    rawMcpResources: mcpResult.resources,
    transportType: mcpResult.transportType,
    summary: analysis.summary,
    collaborationHints: analysis.collaborationHints,
    correlationId: input.correlationId,
    injectionFindings,
    degradedTools: mcpResult.degradedTools,
  };

  if (persist) {
    const persisted = await persist(output);
    return { output, persisted };
  }

  return output;
}
