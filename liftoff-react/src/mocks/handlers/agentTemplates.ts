import { http, HttpResponse } from 'msw'
import { mockAgentTemplates } from '../data/agentTemplates'
import type { DepartmentCategory } from '../../services/agentTemplates'

export const agentTemplatesHandlers = [
  // List templates (must come before :templateId route)
  http.get('*/api/agent-templates', ({ request }) => {
    const url = new URL(request.url)
    const departmentCategory = url.searchParams.get('departmentCategory') as DepartmentCategory | null
    const limit = parseInt(url.searchParams.get('limit') || '50')

    let templates = mockAgentTemplates
    if (departmentCategory) {
      templates = templates.filter(t => t.departmentCategory === departmentCategory)
    }

    return HttpResponse.json({
      templates: templates.slice(0, limit),
      total: templates.length,
    })
  }),

  // Get single template
  http.get('*/api/agent-templates/:templateId', ({ params }) => {
    const template = mockAgentTemplates.find(t => t.id === params.templateId)
    if (!template) {
      return HttpResponse.json({ error: 'Template not found' }, { status: 404 })
    }
    return HttpResponse.json(template)
  }),

  // Create agent from template — called by handleConnectorsContinue on the connector step
  http.post('*/api/agents/from-template', async ({ request }) => {
    const body = await request.json() as { templateId?: string; name?: string }
    const template = mockAgentTemplates.find(t => t.id === body.templateId)
    if (!template) {
      return HttpResponse.json({ error: 'template_not_found', templateId: body.templateId }, { status: 404 })
    }
    // Simulate a short processing delay
    await new Promise(resolve => setTimeout(resolve, 800))
    return HttpResponse.json(
      { agentId: `mock-agent-${body.templateId}-${Date.now()}` },
      { status: 201 },
    )
  }),
]
