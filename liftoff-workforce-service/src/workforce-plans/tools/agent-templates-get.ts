// agent_templates__get Tool
//
// Fetches the full config for a single agent template by id. The CAIO calls
// this after agent_templates__list identifies a potential match to get the
// full role, responsibilities, connector requirements, and trigger config.
//
// Auth: X-Service-Auth with WORKFORCE_SERVICE_TOKEN — same pattern as
// agent_templates__list. Import paths use .js extensions (ESM).

import { log } from '../../infrastructure/logging.js';
import { loadConfig } from '../../infrastructure/config.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface GetInput {
  templateId: string;
}

interface ConnectorRequirement {
  id: string;
  connectorType?: string;
  capability?: string;
  role: 'data_source' | 'tool';
  description: string;
}

interface EscalationPattern {
  trigger: string;
  action: string;
  description: string;
}

interface TriggerConfig {
  type: string;
  cronExpr?: string;
  eventTopic?: string;
}

type GetOutput =
  | {
      found: false;
      message: string;
    }
  | {
      found: true;
      id: string;
      displayName: string;
      description: string;
      roleSummary: string;
      departmentCategory: string;
      defaultAgentType: 'agent' | 'workflow';
      role: string;
      responsibilities: string;
      additionalContext: string;
      requiredConnectors: ConnectorRequirement[];
      optionalConnectors: ConnectorRequirement[];
      escalationPatterns: EscalationPattern[];
      defaultTriggerConfig: TriggerConfig;
    };

interface RawTemplate {
  id: string;
  displayName?: string;
  description?: string;
  roleSummary?: string;
  departmentCategory?: string;
  defaultAgentType?: string;
  role?: string;
  responsibilities?: string;
  additionalContext?: string;
  requiredConnectors?: ConnectorRequirement[];
  optionalConnectors?: ConnectorRequirement[];
  escalationPatterns?: EscalationPattern[];
  defaultTriggerConfig?: TriggerConfig;
}

function getPlatformBackendUrl(): string {
  return loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
}

function getServiceAuthSecret(): string {
  return loadConfig().WORKFORCE_SERVICE_TOKEN;
}

export const agentTemplatesGetTool: WorkforcePlanTool = {
  definition: {
    name: 'agent_templates__get',
    description:
      'Fetch the full config for a single template by id (get ids from `agent_templates__list`). Returns the role title, responsibilities markdown, additional context/rules, connector requirements, and default execution type. Use `roleSummary` as `spec.roleSummary` and `role` as `spec.name`. Connector requirements with a `connectorType` can be matched against `connectors__list_available`; those with only a `capability` cannot be matched directly — skip connector mapping for those entries.',
    input_schema: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'The template id to fetch. Get available ids from agent_templates__list.',
        },
      },
      required: ['templateId'],
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    _ctx: WorkforcePlanToolContext,
  ): Promise<GetOutput> {
    const input = rawInput as unknown as GetInput;
    const baseUrl = getPlatformBackendUrl();
    const secret = getServiceAuthSecret();

    const url = `${baseUrl}/api/internal/agent-templates/${encodeURIComponent(input.templateId)}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { 'X-Service-Auth': secret },
      });
    } catch (err) {
      log.error({ templateId: input.templateId, error: (err as Error).message }, 'agent_templates__get: fetch failed');
      throw err;
    }

    if (resp.status === 404) {
      return {
        found: false,
        message: `Template ${input.templateId} not found. Call agent_templates__list to see available ids.`,
      };
    }

    if (!resp.ok) {
      throw new Error(`agent_templates__get: unexpected HTTP ${resp.status} from platform-backend`);
    }

    const t = await resp.json() as RawTemplate;

    return {
      found: true,
      id: t.id,
      displayName: t.displayName ?? t.id,
      description: t.description ?? '',
      roleSummary: t.roleSummary ?? '',
      departmentCategory: t.departmentCategory ?? '',
      defaultAgentType: t.defaultAgentType === 'workflow' ? 'workflow' : 'agent',
      role: t.role ?? '',
      responsibilities: t.responsibilities ?? '',
      additionalContext: t.additionalContext ?? '',
      requiredConnectors: t.requiredConnectors ?? [],
      optionalConnectors: t.optionalConnectors ?? [],
      escalationPatterns: t.escalationPatterns ?? [],
      defaultTriggerConfig: t.defaultTriggerConfig ?? { type: 'manual' },
    };
  },
};
