// agent_templates__list Tool
//
// Fetches a summary list of pre-built agent templates from platform-backend's
// internal endpoint. The CAIO uses this before drafting a plan from scratch to
// discover whether a suitable template already exists in the catalog.
//
// Auth: X-Service-Auth with WORKFORCE_SERVICE_TOKEN — the endpoint is mounted
// before authMiddleware in PB and validates via WORKFORCE_SERVICE_TOKEN.
// Import paths use .js extensions (ESM).

import { log } from '../../infrastructure/logging.js';
import { loadConfig } from '../../infrastructure/config.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface ListInput {
  departmentCategory?: DepartmentCategory;
  cursor?: string;
}

type DepartmentCategory =
  | 'customer_support'
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'hr'
  | 'legal'
  | 'operations'
  | 'engineering'
  | 'other';

interface TemplateSummary {
  id: string;
  displayName: string;
  description: string;
  departmentCategory: string;
  defaultAgentType: 'agent' | 'workflow';
  requiredConnectorCount: number;
  optionalConnectorCount: number;
}

interface ListOutput {
  templates: TemplateSummary[];
  hasMore: boolean;
  nextCursor?: string;
  message: string;
}

interface ListErrorOutput {
  error: string;
  validValues: string[];
}

type ListResult = ListOutput | ListErrorOutput;

interface RawTemplate {
  id: string;
  displayName?: string;
  description?: string;
  departmentCategory?: string;
  defaultAgentType?: string;
  requiredConnectors?: unknown[];
  optionalConnectors?: unknown[];
}

interface PBListResponse {
  templates?: RawTemplate[];
  hasMore?: boolean;
  nextCursor?: string;
}

function getPlatformBackendUrl(): string {
  return loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
}

function getServiceAuthSecret(): string {
  return loadConfig().WORKFORCE_SERVICE_TOKEN;
}

export const agentTemplatesListTool: WorkforcePlanTool = {
  definition: {
    name: 'agent_templates__list',
    description:
      'Browse the pre-built agent template catalog. Returns a summary list — call `agent_templates__get` on a specific id to read the full config. Call this before drafting a plan from scratch when you have enough context about what the user needs. Filter by `departmentCategory` to narrow results when the use case maps to a department. If `hasMore` is true, re-call with a `departmentCategory` filter rather than paginating.',
    input_schema: {
      type: 'object',
      properties: {
        departmentCategory: {
          type: 'string',
          enum: ['customer_support', 'sales', 'marketing', 'finance', 'hr', 'legal', 'operations', 'engineering', 'other'],
          description: 'Filter by department. Omit to browse all departments.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from a previous call\'s nextCursor. Only use when hasMore was true.',
        },
      },
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    _ctx: WorkforcePlanToolContext,
  ): Promise<ListResult> {
    const input = rawInput as unknown as ListInput;
    const baseUrl = getPlatformBackendUrl();
    const secret = getServiceAuthSecret();

    const url = new URL(`${baseUrl}/api/internal/agent-templates`);
    url.searchParams.set('limit', '100');
    if (input.departmentCategory) url.searchParams.set('departmentCategory', input.departmentCategory);
    if (input.cursor) url.searchParams.set('cursor', input.cursor);

    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        headers: { 'X-Service-Auth': secret },
      });
    } catch (err) {
      log.error({ error: (err as Error).message }, 'agent_templates__list: fetch failed');
      throw err;
    }

    if (resp.status === 400) {
      const body = await resp.json() as { error?: string; validValues?: string[] };
      return {
        error: 'Invalid departmentCategory',
        validValues: body.validValues ?? [],
      };
    }

    if (resp.status === 401) {
      throw new Error('agent_templates__list: service authentication failed (401) — check WORKFORCE_SERVICE_TOKEN');
    }

    if (!resp.ok) {
      throw new Error(`agent_templates__list: unexpected HTTP ${resp.status} from platform-backend`);
    }

    const body = await resp.json() as PBListResponse;
    const rawTemplates = body.templates ?? [];

    const summaries: TemplateSummary[] = rawTemplates.map(t => ({
      id: t.id,
      displayName: t.displayName ?? t.id,
      description: t.description ?? '',
      departmentCategory: t.departmentCategory ?? '',
      defaultAgentType: (t.defaultAgentType === 'workflow' ? 'workflow' : 'agent') as 'agent' | 'workflow',
      requiredConnectorCount: Array.isArray(t.requiredConnectors) ? t.requiredConnectors.length : 0,
      optionalConnectorCount: Array.isArray(t.optionalConnectors) ? t.optionalConnectors.length : 0,
    }));

    const hasMore = body.hasMore ?? false;
    const nextCursor = body.nextCursor;

    let message: string;
    if (summaries.length === 0) {
      message = input.departmentCategory
        ? `No templates found for department '${input.departmentCategory}'. Try a different departmentCategory or omit the filter to browse all.`
        : 'No templates found.';
    } else {
      message = hasMore
        ? 'Templates returned. If hasMore is true, re-call with a departmentCategory filter to narrow results.'
        : `${summaries.length} template${summaries.length === 1 ? '' : 's'} returned.`;
    }

    return { templates: summaries, hasMore, ...(nextCursor ? { nextCursor } : {}), message };
  },
};
