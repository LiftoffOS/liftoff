import { http, HttpResponse, delay } from 'msw'
import { generateMockPersonnel } from '../data/personAssignments'

const mockPersonnel = generateMockPersonnel()

export const personAssignmentsHandlers = [
  // GET /api/person-assignments/personnel — List all personnel with assignments
  http.get('*/api/person-assignments/personnel', async ({ request }) => {
    await delay(200)

    const url = new URL(request.url)
    const tenantId = url.searchParams.get('tenantId')
    if (!tenantId) {
      return HttpResponse.json({ error: 'tenantId required' }, { status: 400 })
    }

    return HttpResponse.json({ personnel: mockPersonnel })
  }),

  // PUT /api/person-assignments/:accountId — Update assignments for a person
  http.put('*/api/person-assignments/:accountId', async ({ params, request }) => {
    await delay(300)

    const url = new URL(request.url)
    const tenantId = url.searchParams.get('tenantId')
    if (!tenantId) {
      return HttpResponse.json({ error: 'tenantId required' }, { status: 400 })
    }

    const { accountId } = params
    const body = await request.json() as { assignments: Array<{ agentId: string; agentType: 'internal' | 'external' }> }

    const person = mockPersonnel.find(p => p.accountId === accountId)
    if (!person) {
      return HttpResponse.json({ error: 'Person not found in tenant' }, { status: 404 })
    }

    // Look up agent names from the known mock data
    const agentNameMap: Record<string, string> = {
      'internal-agent-sales-001': 'Sales Outreach Agent',
      'internal-agent-support-002': 'Customer Support Bot',
      'internal-agent-onboarding-003': 'Onboarding Coordinator',
      'internal-agent-billing-004': 'Billing Assistant',
      'ext-agent-1': 'Data Analysis Bot',
      'ext-agent-2': 'Customer Support Assistant',
      'ext-agent-3': 'Code Review Helper',
      'ext-agent-4': 'Marketing Analytics',
      'ext-agent-5': 'HR Onboarding Bot',
    }

    const oldCount = person.assignments.length
    person.assignments = body.assignments.map(a => ({
      agentId: a.agentId,
      agentType: a.agentType,
      agentName: agentNameMap[a.agentId] || `Agent ${a.agentId.slice(-3)}`,
    }))
    const newCount = person.assignments.length

    const added = Math.max(0, newCount - oldCount)
    const removed = Math.max(0, oldCount - newCount)

    return HttpResponse.json({ success: true, added, removed })
  }),
]
