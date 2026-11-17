// MSW handler for the unified /api/teams/workforce endpoint

import { http, HttpResponse, delay } from 'msw'
import { generateMockInternalAgents } from '../data/internalAgents'
import { generateMockExternalAgents } from '../data/externalAgents'
import { generateMockPersonnel } from '../data/personAssignments'
import type { WorkforceClaudeCodeKey } from '../../hooks/useWorkforce'

const mockInternalAgents = generateMockInternalAgents()
const mockExternalAgents = generateMockExternalAgents()
const mockPersonnel = generateMockPersonnel()

const mockClaudeCodeKeys: WorkforceClaudeCodeKey[] = [
  {
    id: 'cc-proxy-001',
    tenantId: 'tenant-mock-001',
    accountId: 'acc-mock-001',
    keyPrefix: 'liftoff_sk_Jd8xKm2p',
    keyHint: 'k2p1',
    name: 'Jane Smith (Claude Code)',
    description: null,
    planType: null,
    costPerMonth: null,
    status: 'active',
    lastUsedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    keyType: 'developer_proxy',
    vendor: 'anthropic',
  },
  {
    id: 'cc-proxy-002',
    tenantId: 'tenant-mock-001',
    accountId: 'acc-mock-002',
    keyPrefix: 'liftoff_sk_Rn4bQs7v',
    keyHint: 's7v2',
    name: 'Marcus Chen (Claude Code)',
    description: null,
    planType: null,
    costPerMonth: null,
    status: 'active',
    lastUsedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    keyType: 'developer_proxy',
    vendor: 'anthropic',
  },
  {
    id: 'cc-proxy-003',
    tenantId: 'tenant-mock-001',
    accountId: 'acc-mock-003',
    keyPrefix: 'liftoff_sk_Wc9mFt3q',
    keyHint: 't3q8',
    name: 'Priya Patel (Claude Code)',
    description: null,
    planType: null,
    costPerMonth: null,
    status: 'active',
    lastUsedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    keyType: 'developer_proxy',
    vendor: 'anthropic',
  },
  {
    id: 'cc-proxy-004',
    tenantId: 'tenant-mock-001',
    accountId: 'acc-mock-004',
    keyPrefix: 'liftoff_sk_Hv6yLd5n',
    keyHint: 'd5n3',
    name: 'Alex Rivera (Codex)',
    description: null,
    planType: null,
    costPerMonth: null,
    status: 'active',
    lastUsedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    keyType: 'developer_proxy',
    vendor: 'openai',
  },
  {
    id: 'cc-mcp-001',
    tenantId: 'tenant-mock-001',
    accountId: 'acc-mock-002',
    keyPrefix: 'liftoff_mcp_Xr7kPn2q',
    keyHint: 'n2q4',
    name: 'Marcus Chen (Claude Code)',
    description: 'MCP collab token',
    planType: null,
    costPerMonth: null,
    status: 'active',
    lastUsedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    keyType: 'mcp',
    vendor: 'claude_code_mcp',
  },
]

export const workforceHandlers = [
  http.get('*/api/teams/workforce', async ({ request }) => {
    await delay(150)

    const url = new URL(request.url)
    const tenantId = url.searchParams.get('tenantId')
    if (!tenantId) {
      return HttpResponse.json({ error: 'tenantId required' }, { status: 400 })
    }

    return HttpResponse.json({
      internalAgents: mockInternalAgents,
      externalAgents: mockExternalAgents,
      claudeCodeKeys: mockClaudeCodeKeys,
      personnel: mockPersonnel,
    })
  }),
]
