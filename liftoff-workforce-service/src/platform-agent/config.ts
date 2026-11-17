// Loads CAIO's / HRBP's config from platform-backend's internal_agents table
// via the service-auth GET /api/internal-agents/system/:id endpoint. That
// handler is service-auth only and constrained to is_system=TRUE rows, so it
// does not need tenant scoping (system agents have tenant_id IS NULL).
//
// Cached per-process with a 60s TTL. Process-lifetime caching was unsafe:
// when PB migrations and workforce-service rolls overlap (e.g. a deploy that
// updates the HRBP system_prompt), an instance that started up *before* the
// PB migration applied would cache the pre-migration prompt for its entire
// lifetime. A short TTL bounds prompt-update propagation to one minute while
// keeping load on PB negligible (1 fetch per instance per minute).

import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';
import { log } from '../infrastructure/logging.js';

export interface PlatformAgentConfig {
  agentId: string;
  systemRole: 'caio' | 'hrbp';
  systemPromptTemplate: string;
  modelConfig: { tier?: 'flagship' | 'medium' | 'small'; modelId?: string };
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  config: PlatformAgentConfig;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

interface SystemAgentResponse {
  id: string;
  systemRole?: string;
  systemPrompt?: string;
  modelConfig?: { tier?: 'flagship' | 'medium' | 'small'; modelId?: string };
}

export async function loadPlatformAgentConfig(agentId: string): Promise<PlatformAgentConfig> {
  const cached = cache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const url = `${baseUrl}/api/internal-agents/system/${agentId}`;
  const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);
  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to load platform agent config: ${response.status} ${body}`);
  }
  const agent = (await response.json()) as SystemAgentResponse;
  if (agent.systemRole !== 'caio' && agent.systemRole !== 'hrbp') {
    throw new Error(`Unexpected systemRole for platform agent ${agentId}: ${agent.systemRole}`);
  }

  const config: PlatformAgentConfig = {
    agentId: agent.id,
    systemRole: agent.systemRole,
    systemPromptTemplate: agent.systemPrompt ?? '',
    modelConfig: agent.modelConfig ?? { tier: 'medium' },
  };
  cache.set(agentId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
  log.info({ agentId, systemRole: config.systemRole }, 'Loaded platform-agent config');
  return config;
}

/** For tests only. Clears the in-process cache. */
export function _resetPlatformAgentConfigCache(): void {
  cache.clear();
}
