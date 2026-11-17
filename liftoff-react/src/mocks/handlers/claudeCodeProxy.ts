// MSW handlers for Claude Code proxy key endpoints

import { http, HttpResponse } from 'msw'
import { generateMockClaudeCodeProxyKeys, type MockClaudeCodeProxyKey } from '../data/claudeCodeProxy'

// Generate mock data once and cache it
const mockProxyKeys = generateMockClaudeCodeProxyKeys()

export const claudeCodeProxyHandlers = [
  // IMPORTANT: Specific routes must come before parameterized routes

  // Tenant-wide usage stats — must be before /keys/:keyId
  http.get('*/api/claude-code-proxy/keys/usage', () => {
    return HttpResponse.json({
      totalInputTokens: 4820000,
      totalOutputTokens: 1230000,
      totalRequests: 847,
      estimatedCostUsd: 32.85,
      byModel: [
        {
          model: 'claude-sonnet-4-6',
          inputTokens: 3200000,
          outputTokens: 890000,
          requests: 612,
          estimatedCostUsd: 22.95,
        },
        {
          model: 'claude-opus-4-6',
          inputTokens: 1620000,
          outputTokens: 340000,
          requests: 235,
          estimatedCostUsd: 9.90,
        },
      ],
    })
  }),

  // List proxy keys
  http.get('*/api/claude-code-proxy/keys', () => {
    return HttpResponse.json({ keys: mockProxyKeys })
  }),

  // Get single proxy key — must be after /keys/usage
  http.get('*/api/claude-code-proxy/keys/:keyId', ({ params }) => {
    const key = mockProxyKeys.find(k => k.id === params.keyId)
    if (!key) {
      return HttpResponse.json({ error: 'Proxy key not found' }, { status: 404 })
    }
    return HttpResponse.json(key)
  }),

  // Per-key usage stats
  http.get('*/api/claude-code-proxy/keys/:keyId/usage', ({ params }) => {
    const key = mockProxyKeys.find(k => k.id === params.keyId)
    if (!key) {
      return HttpResponse.json({ error: 'Proxy key not found' }, { status: 404 })
    }
    return HttpResponse.json({
      totalInputTokens: 980000,
      totalOutputTokens: 245000,
      totalRequests: 163,
      estimatedCostUsd: 6.60,
      byModel: [
        {
          model: 'claude-sonnet-4-6',
          inputTokens: 980000,
          outputTokens: 245000,
          requests: 163,
          estimatedCostUsd: 6.60,
        },
      ],
    })
  }),

  // Update proxy key
  http.put('*/api/claude-code-proxy/keys/:keyId', async ({ params, request }) => {
    const key = mockProxyKeys.find(k => k.id === params.keyId)
    if (!key) {
      return HttpResponse.json({ error: 'Proxy key not found' }, { status: 404 })
    }
    const body = await request.json() as Partial<MockClaudeCodeProxyKey>
    Object.assign(key, body, { updatedAt: new Date().toISOString() })
    return HttpResponse.json(key)
  }),

  // Revoke proxy key
  http.delete('*/api/claude-code-proxy/keys/:keyId', ({ params }) => {
    const key = mockProxyKeys.find(k => k.id === params.keyId)
    if (!key) {
      return HttpResponse.json({ error: 'Proxy key not found' }, { status: 404 })
    }
    key.status = 'revoked'
    key.updatedAt = new Date().toISOString()
    return new HttpResponse(null, { status: 204 })
  }),
]
