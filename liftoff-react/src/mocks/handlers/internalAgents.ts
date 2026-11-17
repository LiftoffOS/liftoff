import { http, HttpResponse } from 'msw'
import { generateMockInternalAgents, generateMockInternalAgentVersions } from '../data/internalAgents'
import { generateMockAgentSkills } from '../data/agentSkills'

// Generate mock data once and cache it
const mockInternalAgents = generateMockInternalAgents()

export const internalAgentsHandlers = [
  // IMPORTANT: Specific routes must come before parameterized routes
  // Otherwise :internalAgentId captures "recently-viewed", "distill", etc.
  // Using wildcard (*) to match any origin (localhost or production URL)

  // Get recently viewed internal agents (must be before :internalAgentId route)
  http.get('*/api/internal-agents/recently-viewed', ({ request }) => {
    const url = new URL(request.url)
    const limit = parseInt(url.searchParams.get('limit') || '6')

    return HttpResponse.json({
      internalAgents: mockInternalAgents.slice(0, limit).map((internalAgent, index) => ({
        internalAgent,
        viewedAt: new Date(Date.now() - index * 60 * 60 * 1000).toISOString(),
      })),
    })
  }),

  // Check nickname availability - must be before :internalAgentId route
  http.get('*/api/internal-agents/check-nickname', ({ request }) => {
    const url = new URL(request.url)
    const nickname = url.searchParams.get('nickname') || ''
    const excludeId = url.searchParams.get('excludeId')

    const conflict = mockInternalAgents.find(
      a => a.messagingNickname === nickname && a.id !== excludeId
    )

    return HttpResponse.json({
      available: !conflict,
      conflictWith: conflict ? conflict.role : undefined,
    })
  }),

  // Generate department slug - must be before :internalAgentId route
  http.post('*/api/internal-agents/department-slug', async ({ request }) => {
    const body = await request.json() as { role?: string }
    const slug = (body.role || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32)
    return HttpResponse.json({ slug })
  }),

  // Distill internal agent (streaming SSE) - must be before :internalAgentId route
  http.post('*/api/internal-agents/distill-stream', async () => {
    const encoder = new TextEncoder()
    const stages: string[] = ['connected', 'validating', 'analyzing', 'generating', 'finalizing']
    const stream = new ReadableStream({
      start(controller) {
        let index = 0
        const send = () => {
          if (index < stages.length) {
            controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify({ stage: stages[index] })}\n\n`))
            index++
            setTimeout(send, 200)
          } else {
            // Mirrors the real payload: the compiled prompt stays server-side
            // and only the handle is announced. `distillId` is what the client
            // guard checks, so a mock without it fails every distill.
            const result = {
              agentType: 'agent',
              distillId: '11111111-1111-4111-8111-111111111111',
              summary: 'AI-powered assistant for handling customer interactions',
            }
            controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify(result)}\n\n`))
            controller.close()
          }
        }
        send()
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

  // Preview-lite distill for fused onboarding's hire_confirm step. Returns
  // just the summary; the confirm card renders role/integrations from the
  // input the user already typed. Must be before :internalAgentId route.
  http.post('*/api/internal-agents/distill-preview-lite', async () => {
    await new Promise(resolve => setTimeout(resolve, 400))
    return HttpResponse.json({
      summary: 'Handles inbound customer inquiries, qualifies opportunities, and routes complex cases to the right teammate while keeping every interaction logged and reviewable.',
    })
  }),

  // Distill internal agent (non-streaming) - must be before :internalAgentId route
  http.post(`*/api/internal-agents/distill`, async () => {
    // Simulate some processing delay
    await new Promise(resolve => setTimeout(resolve, 500))

    // agentType and workflowVisualizationSteps are on the real response and
    // were missing here, so the update page's Optimize never populated the
    // workflow visualization under MSW. Included now so the mocked flow
    // exercises the same path the live one does.
    return HttpResponse.json({
      agentType: 'agent',
      distillId: '22222222-2222-4222-8222-222222222222',
      summary: 'AI-powered assistant for handling customer interactions',
      workflowVisualizationSteps: [
        { id: 'intake', label: 'Read the incoming request' },
        { id: 'resolve', label: 'Draft a response from the knowledge base' },
        { id: 'handoff', label: 'Escalate anything unresolved' },
      ],
    })
  }),

  // List internal agents
  http.get(`*/api/internal-agents`, ({ request }) => {
    const url = new URL(request.url)
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const status = url.searchParams.get('status')

    let filteredAgents = mockInternalAgents
    if (status) {
      filteredAgents = mockInternalAgents.filter(a => a.status === status)
    }

    return HttpResponse.json({
      internalAgents: filteredAgents.slice(0, limit),
      cursor: null,
      hasMore: false,
      total: filteredAgents.length,
    })
  }),

  // Create internal agent
  http.post(`*/api/internal-agents`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    const newAgent = {
      id: `internal-agent-${Date.now()}`,
      role: body.role,
      responsibilities: body.responsibilities,
      integrations: body.integrations,
      additionalContext: body.additionalContext || null,
      summary: body.summary || null,
      // No prompt echo. The real server resolves body.distillId to the stored
      // artifact and keeps the compiled prompt; nothing comes back out.
      temperature: 0.7,
      status: body.status || 'draft',
      currentVersion: 1,
      tasksCompleted: 0,
      tasks30d: 0,
      monthlyCost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActive: null,
      messagingNickname: null,
      attachments: body.attachments ?? [],
    }
    return HttpResponse.json(newAgent, { status: 201 })
  }),

  // Get single internal agent
  http.get(`*/api/internal-agents/:internalAgentId`, ({ params }) => {
    const agent = mockInternalAgents.find(a => a.id === params.internalAgentId)
    if (!agent) {
      return HttpResponse.json({ error: 'Internal agent not found' }, { status: 404 })
    }
    return HttpResponse.json(agent)
  }),

  // Update internal agent
  http.put(`*/api/internal-agents/:internalAgentId`, async ({ params, request }) => {
    const body = await request.json() as Record<string, unknown>
    const agent = mockInternalAgents.find(a => a.id === params.internalAgentId)
    if (!agent) {
      return HttpResponse.json({ error: 'Internal agent not found' }, { status: 404 })
    }
    const updatedAgent = { ...agent, ...body, updatedAt: new Date().toISOString() }
    return HttpResponse.json(updatedAgent)
  }),

  // Update internal agent status
  http.patch(`*/api/internal-agents/:internalAgentId/status`, async ({ params, request }) => {
    const body = await request.json() as { status: string }
    const agent = mockInternalAgents.find(a => a.id === params.internalAgentId)
    if (!agent) {
      return HttpResponse.json({ error: 'Internal agent not found' }, { status: 404 })
    }
    const updatedAgent = {
      ...agent,
      status: body.status,
      updatedAt: new Date().toISOString(),
      lastActive: body.status === 'active' ? new Date().toISOString() : agent.lastActive,
    }
    return HttpResponse.json(updatedAgent)
  }),

  // Delete internal agent
  http.delete(`*/api/internal-agents/:internalAgentId`, ({ params }) => {
    const agent = mockInternalAgents.find(a => a.id === params.internalAgentId)
    if (!agent) {
      return HttpResponse.json({ error: 'Internal agent not found' }, { status: 404 })
    }
    return new HttpResponse(null, { status: 204 })
  }),

  // Get internal agent versions
  http.get(`*/api/internal-agents/:internalAgentId/versions`, ({ params }) => {
    const agent = mockInternalAgents.find(a => a.id === params.internalAgentId)
    if (!agent) {
      return HttpResponse.json({ versions: [] })
    }
    return HttpResponse.json({ versions: generateMockInternalAgentVersions(agent) })
  }),

  // Get a specific version of an internal agent
  http.get(`*/api/internal-agents/:internalAgentId/versions/:version`, ({ params }) => {
    const agent = mockInternalAgents.find(a => a.id === params.internalAgentId)
    if (!agent) {
      return HttpResponse.json({ error: 'Internal agent not found' }, { status: 404 })
    }
    const versions = generateMockInternalAgentVersions(agent)
    const version = versions.find(v => v.version === parseInt(params.version as string, 10))
    if (!version) {
      return HttpResponse.json({ error: 'Version not found' }, { status: 404 })
    }
    return HttpResponse.json(version)
  }),

  // Rollback internal agent to a version
  http.post(`*/api/internal-agents/:internalAgentId/rollback`, async ({ params, request }) => {
    const body = await request.json() as { version: number }
    const agent = mockInternalAgents.find(a => a.id === params.internalAgentId)
    if (!agent) {
      return HttpResponse.json({ error: 'Internal agent not found' }, { status: 404 })
    }
    return HttpResponse.json({
      ...agent,
      currentVersion: body.version,
      updatedAt: new Date().toISOString(),
    })
  }),

  // Record internal agent view (fire-and-forget)
  http.post(`*/api/internal-agents/:internalAgentId/views`, () => {
    return new HttpResponse(null, { status: 204 })
  }),

  // Get skills for an internal agent
  http.get('*/api/internal-agents/:internalAgentId/skills', ({ params }) => {
    const { internalAgentId } = params as { internalAgentId: string }
    const skills = generateMockAgentSkills(internalAgentId)
    return HttpResponse.json({ skills })
  }),

]

// Backward compatibility alias
export const teamsHandlers = internalAgentsHandlers
