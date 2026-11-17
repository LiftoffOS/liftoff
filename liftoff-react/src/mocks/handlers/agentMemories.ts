import { http, HttpResponse } from 'msw'
import { generateMockAgentMemories, mockAgentMemoriesStore } from '../data/agentMemories'

export const agentMemoryHandlers = [
  // Get memories for an internal agent (paginated)
  http.get('*/api/internal-agents/:internalAgentId/memories', ({ params, request }) => {
    const { internalAgentId } = params as { internalAgentId: string }

    // Initialize store for this agent on first access
    if (!mockAgentMemoriesStore.has(internalAgentId)) {
      mockAgentMemoriesStore.set(internalAgentId, generateMockAgentMemories(internalAgentId))
    }

    const memories = mockAgentMemoriesStore.get(internalAgentId)!
    const url = new URL(request.url)
    const limit = parseInt(url.searchParams.get('limit') || '20', 10)
    const cursorParam = url.searchParams.get('cursor')
    const offset = cursorParam !== null ? parseInt(cursorParam, 10) : 0

    const page = memories.slice(offset, offset + limit)
    const nextOffset = offset + limit
    const nextCursor = nextOffset < memories.length ? String(nextOffset) : null

    return HttpResponse.json({
      memories: page,
      nextCursor,
      total: memories.length,
    })
  }),

  // Delete a memory for an internal agent
  http.delete('*/api/internal-agents/:internalAgentId/memories/:memoryId', ({ params }) => {
    const { internalAgentId, memoryId } = params as { internalAgentId: string; memoryId: string }

    // Initialize store for this agent on first access
    if (!mockAgentMemoriesStore.has(internalAgentId)) {
      mockAgentMemoriesStore.set(internalAgentId, generateMockAgentMemories(internalAgentId))
    }

    const memories = mockAgentMemoriesStore.get(internalAgentId)!
    const index = memories.findIndex(m => m.id === memoryId)

    if (index === -1) {
      return HttpResponse.json({ error: 'Memory not found' }, { status: 404 })
    }

    memories.splice(index, 1)
    mockAgentMemoriesStore.set(internalAgentId, memories)

    return new HttpResponse(null, { status: 204 })
  }),
]
