// Agent Status Service — fetches live invocation status from the platform-backend
// admin proxy (which forwards to tenant-runtime). Admin-only surface.

import { api } from './api'
import type { AgentStatusResponse } from '../types/agentStatus'

export async function getAgentStatus(
  tenantId: string,
  invocationId: string,
): Promise<AgentStatusResponse> {
  return api.get<AgentStatusResponse>(
    `/api/admin/agent-status/${encodeURIComponent(tenantId)}/${encodeURIComponent(invocationId)}`,
  )
}
