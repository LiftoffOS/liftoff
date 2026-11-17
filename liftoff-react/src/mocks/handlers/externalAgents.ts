import { http, HttpResponse } from 'msw'
import { generateMockExternalAgents, type MockExternalAgent } from '../data/externalAgents'

// Generate mock data once and cache it
const mockExternalAgents = generateMockExternalAgents()

export const externalAgentsHandlers = [
  // IMPORTANT: Specific routes must come before parameterized routes

  // Discover external agent (SSE streaming) - must be before :agentId routes
  http.post('*/api/external-agents/discover-stream', async () => {
    // Return a simple SSE stream with progress and complete events
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const stages = ['connected', 'validating', 'discovering', 'analyzing', 'classifying', 'finalizing']
        let index = 0

        const sendEvent = () => {
          if (index < stages.length) {
            const event = `event: progress\ndata: ${JSON.stringify({ stage: stages[index] })}\n\n`
            controller.enqueue(encoder.encode(event))
            index++
            setTimeout(sendEvent, 200)
          } else {
            // Send complete event
            const completeData = {
              capabilities: [
                { id: 'cap-new-1', name: 'analyze', description: 'Analyze data' },
              ],
              resources: [],
              toolClassifications: { analyze: [] },
              summary: 'Mock discovered agent summary',
              collaborationHints: 'Works well with data teams',
            }
            const completeEvent = `event: complete\ndata: ${JSON.stringify(completeData)}\n\n`
            controller.enqueue(encoder.encode(completeEvent))
            controller.close()
          }
        }
        sendEvent()
      },
    })

    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }),

  // List external agents
  http.get('*/api/external-agents', ({ request }) => {
    const url = new URL(request.url)
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const status = url.searchParams.get('status')

    let filteredAgents = mockExternalAgents
    if (status) {
      filteredAgents = mockExternalAgents.filter(a => a.status === status)
    }

    return HttpResponse.json({
      agents: filteredAgents.slice(0, limit),
      cursor: null,
      hasMore: false,
      total: filteredAgents.length,
    })
  }),

  // Create external agent
  http.post('*/api/external-agents', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    const newAgent: MockExternalAgent = {
      id: `ext-agent-${Date.now()}`,
      tenantId: 'tenant-mock-001',
      name: body.name as string || 'New Agent',
      endpointUrl: body.endpointUrl as string || '',
      description: body.description as string || '',
      connectionType: (body.connectionType as 'automatic' | 'custom') || 'automatic',
      authType: (body.authType as 'none' | 'api_key' | 'bearer_token' | 'custom_headers') || 'none',
      collaborationMode: (body.collaborationMode as 'request_help' | 'receive_delegated' | 'two_way' | 'observe_only') || 'two_way',
      summary: body.summary as string | null || null,
      collaborationHints: body.collaborationHints as string | null || null,
      detectedCapabilities: (body.detectedCapabilities as { id: string; name: string; description: string }[]) || [],
      detectedResources: [],
      toolClassifications: (body.toolClassifications as Record<string, string[]>) || {},
      allowedInternalAgentIds: (body.allowedInternalAgentIds as string[]) || [],
      requestRules: (body.requestRules as unknown[]) || [],
      status: 'connected',
      capabilityChanges: null,
      currentVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return HttpResponse.json(newAgent, { status: 201 })
  }),

  // Get single external agent
  http.get('*/api/external-agents/:agentId', ({ params }) => {
    const agent = mockExternalAgents.find(a => a.id === params.agentId)
    if (!agent) {
      return HttpResponse.json({ error: 'External agent not found' }, { status: 404 })
    }
    return HttpResponse.json(agent)
  }),

  // Update external agent
  http.put('*/api/external-agents/:agentId', async ({ params, request }) => {
    const body = await request.json() as Record<string, unknown>
    const agent = mockExternalAgents.find(a => a.id === params.agentId)
    if (!agent) {
      return HttpResponse.json({ error: 'External agent not found' }, { status: 404 })
    }
    Object.assign(agent, body, { updatedAt: new Date().toISOString() })
    return HttpResponse.json(agent)
  }),

  // Update external agent status
  http.patch('*/api/external-agents/:agentId/status', async ({ params, request }) => {
    const body = await request.json() as { status: string }
    const agent = mockExternalAgents.find(a => a.id === params.agentId)
    if (!agent) {
      return HttpResponse.json({ error: 'External agent not found' }, { status: 404 })
    }
    agent.status = body.status as typeof agent.status
    agent.updatedAt = new Date().toISOString()
    return HttpResponse.json(agent)
  }),

  // Delete external agent
  http.delete('*/api/external-agents/:agentId', ({ params }) => {
    const index = mockExternalAgents.findIndex(a => a.id === params.agentId)
    if (index === -1) {
      return HttpResponse.json({ error: 'External agent not found' }, { status: 404 })
    }
    mockExternalAgents.splice(index, 1)
    return new HttpResponse(null, { status: 204 })
  }),

  // Get external agent versions
  http.get('*/api/external-agents/:agentId/versions', ({ params }) => {
    const agent = mockExternalAgents.find(a => a.id === params.agentId)
    if (!agent) {
      return HttpResponse.json({ versions: [] })
    }

    // Generate versions based on agent's currentVersion
    const versions = []
    const collaborationModes = ['two_way', 'request_help', 'receive_delegated', 'observe_only'] as const

    for (let v = agent.currentVersion; v >= 1; v--) {
      const versionDate = new Date(agent.createdAt)
      versionDate.setDate(versionDate.getDate() - (agent.currentVersion - v) * 7)

      const isCurrentVersion = v === agent.currentVersion
      const isFirstVersion = v === 1

      versions.push({
        id: `version-${agent.id}-${v}`,
        externalAgentId: agent.id,
        version: v,
        name: isFirstVersion ? `${agent.name} (Original)` : agent.name,
        description: isFirstVersion
          ? (agent.description ? `${agent.description} - Initial setup.` : 'Initial configuration.')
          : agent.description,
        summary: agent.summary,
        collaborationHints: agent.collaborationHints,
        detectedCapabilities: isCurrentVersion
          ? agent.detectedCapabilities
          : agent.detectedCapabilities.slice(0, Math.max(1, agent.detectedCapabilities.length - (agent.currentVersion - v))),
        detectedResources: agent.detectedResources,
        toolClassifications: agent.toolClassifications,
        allowedInternalAgentIds: isCurrentVersion
          ? agent.allowedInternalAgentIds
          : agent.allowedInternalAgentIds.slice(0, Math.max(1, v)),
        requestRules: isCurrentVersion
          ? agent.requestRules
          : agent.requestRules?.slice(0, Math.max(1, v)),
        collaborationMode: isFirstVersion ? 'observe_only' : collaborationModes[v % collaborationModes.length],
        source: isFirstVersion ? 'create' : (v % 2 === 0 ? 'discover' : 'manual'),
        createdBy: null,
        createdAt: versionDate.toISOString(),
      })
    }

    return HttpResponse.json({ versions })
  }),

  // Rollback external agent
  http.post('*/api/external-agents/:agentId/rollback', async ({ params }) => {
    const agent = mockExternalAgents.find(a => a.id === params.agentId)
    if (!agent) {
      return HttpResponse.json({ error: 'External agent not found' }, { status: 404 })
    }
    return HttpResponse.json({
      ...agent,
      currentVersion: agent.currentVersion + 1,
      updatedAt: new Date().toISOString(),
    })
  }),

  // Rediscover external agent (SSE streaming)
  http.post('*/api/external-agents/:agentId/rediscover-stream', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const stages = ['connected', 'validating', 'discovering', 'analyzing', 'classifying', 'finalizing']
        let index = 0

        const sendEvent = () => {
          if (index < stages.length) {
            const event = `event: progress\ndata: ${JSON.stringify({ stage: stages[index] })}\n\n`
            controller.enqueue(encoder.encode(event))
            index++
            setTimeout(sendEvent, 200)
          } else {
            const completeData = {
              capabilities: [
                { id: 'cap-rediscovered-1', name: 'analyze', description: 'Analyze data' },
              ],
              resources: [],
              toolClassifications: { analyze: [] },
              summary: 'Rediscovered agent summary',
              collaborationHints: 'Updated collaboration hints',
            }
            const completeEvent = `event: complete\ndata: ${JSON.stringify(completeData)}\n\n`
            controller.enqueue(encoder.encode(completeEvent))
            controller.close()
          }
        }
        sendEvent()
      },
    })

    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }),
]
