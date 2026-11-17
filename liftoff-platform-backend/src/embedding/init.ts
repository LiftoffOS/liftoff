// Platform-backend bootstrap for the shared @liftoffos/embedding client.
//
// Constructs providers using platform-backend's secret helpers and registers
// a single onUsage callback that persists every embed call (success + failure)
// into llm_usage_log with full attribution: tenantId, agentId, sessionId,
// threadId, invocationId, itemId.

import OpenAI from 'openai';
import {
  embeddingClient,
  OpenAIEmbeddingProvider,
  GoogleEmbeddingProvider,
  VoyageEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderClient,
  type EmbeddingUsageEvent,
} from '@liftoffos/embedding';
import { getOpenAIApiKeyForGroup } from '../infrastructure/secrets';
import { getPool, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const VALID_PROVIDERS: ReadonlySet<EmbeddingProvider> = new Set(['openai', 'google', 'voyage']);

/** Returns an explicit EMBEDDING_PROVIDER override if set to a known value.
 *  Otherwise undefined so the client falls back to defaultPreference. */
function explicitDefaultProvider(): EmbeddingProvider | undefined {
  const raw = process.env.EMBEDDING_PROVIDER;
  if (raw && VALID_PROVIDERS.has(raw as EmbeddingProvider)) {
    return raw as EmbeddingProvider;
  }
  return undefined;
}

export async function initEmbeddingClient(): Promise<void> {
  // Read env at init time, not at module load — keeps the function testable
  // and lets a process change EMBEDDING_PROVIDER between import and init().
  const gcpProject = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const gcpLocation = process.env.GCP_LOCATION || process.env.VERTEX_LOCATION || 'us-west1';

  // Construct OpenAI via the existing per-purpose key path (background-services).
  // Other groups can be wired later if we need per-purpose embedding key segregation.
  const openaiKey = await getOpenAIApiKeyForGroup('background-services');

  const providers: Partial<Record<EmbeddingProvider, EmbeddingProviderClient>> = {};
  if (openaiKey) {
    providers.openai = new OpenAIEmbeddingProvider(new OpenAI({ apiKey: openaiKey }));
  }
  if (gcpProject) {
    providers.google = new GoogleEmbeddingProvider({ projectId: gcpProject, location: gcpLocation });
  }
  if (process.env.VOYAGE_API_KEY) {
    providers.voyage = new VoyageEmbeddingProvider(process.env.VOYAGE_API_KEY);
  }
  embeddingClient.init({
    providers,
    defaultProvider: explicitDefaultProvider(),
    // Production preference: GCP-native first (low latency, hoisted on Cloud
    // Run), then Voyage (best quality), then OpenAI (fallback).
    defaultPreference: ['google', 'voyage', 'openai'],
  });

  // Persist every embed call (success + failure) to llm_usage_log.
  embeddingClient.onUsage(async (event: EmbeddingUsageEvent) => {
    try {
      await withAdminScope({ caller: 'embedding.init', reason: 'llm_usage_log embed-usage writer: tenant_id may be NULL (platform embeds) — content table' }, (client) => client.query(
        `INSERT INTO llm_usage_log (
           timestamp, provider, model,
           input_tokens, output_tokens, web_search_requests,
           success, error_message,
           tenant_id, purpose, agent_id, session_id,
           thread_id, invocation_id, item_id
         ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          event.timestamp,
          event.provider,
          event.model,
          event.inputTokens,
          event.success,
          event.error || null,
          event.context?.tenantId || null,
          event.context?.purpose || null,
          event.context?.agentId || null,
          event.context?.sessionId || null,
          event.context?.threadId || null,
          event.context?.invocationId || null,
          event.context?.itemId || null,
        ],
      ));
    } catch (err) {
      log.error({
        error: (err as Error).message,
        provider: event.provider,
        purpose: event.context?.purpose,
      }, 'Failed to persist embedding usage event');
    }
  });

  log.info('Platform-backend embedding client initialized');
}
