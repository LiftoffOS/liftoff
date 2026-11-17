import { useQuery } from '@tanstack/react-query'
import {
  listAllAgentTemplates,
  type AgentTemplateCard,
  type DepartmentCategory,
} from '../services/agentTemplates'

export const AGENT_TEMPLATES_QUERY_KEY = ['agentTemplates'] as const

/**
 * Loads the agent-template catalog as gallery cards. Pages through the list
 * endpoint to exhaustion so no template is dropped at the pagination boundary
 * (the catalog has more than one page). Returns the same `{ templates, total }`
 * shape the page consumers expect.
 *
 * Cards only. Opening a template fetches the rest via `getAgentTemplate`, which
 * is what keeps this exhaustive sweep from being a copy of the whole catalog's
 * prompt text.
 */
export function useAgentTemplates(departmentCategory?: DepartmentCategory) {
  return useQuery({
    queryKey: [...AGENT_TEMPLATES_QUERY_KEY, departmentCategory],
    queryFn: async (): Promise<{ templates: AgentTemplateCard[]; total: number }> => {
      const templates = await listAllAgentTemplates(departmentCategory)
      return { templates, total: templates.length }
    },
    staleTime: 5 * 60 * 1000, // 5 minutes — templates change rarely
  })
}
