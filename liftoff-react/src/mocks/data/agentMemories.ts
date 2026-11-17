// Mock agent memories data for development

export interface AgentMemory {
  id: string
  content: string
  source: string
  createdAt: string  // ISO 8601
  usefulnessScore?: number
  lastUsedAt?: string
}

// Full pool of realistic agent memory entries
const MEMORY_POOL: Omit<AgentMemory, 'id' | 'createdAt'>[] = [
  {
    content: 'User prefers concise bullet-point summaries over prose paragraphs when reporting task results.',
    source: 'chat',
    usefulnessScore: 0.92,
    lastUsedAt: '2026-04-20T14:32:00Z',
  },
  {
    content: 'The Salesforce sandbox org URL is https://acme--staging.sandbox.my.salesforce.com — use this for all test runs, never production.',
    source: 'tool-result',
    usefulnessScore: 0.87,
    lastUsedAt: '2026-04-18T09:10:00Z',
  },
  {
    content: 'When drafting outbound emails, always include the prospect\'s LinkedIn headline in the opener to increase reply rates. User confirmed this increased replies by ~22% in A/B test.',
    source: 'reflection',
    usefulnessScore: 0.95,
    lastUsedAt: '2026-04-22T11:05:00Z',
  },
  {
    content: 'Do not contact leads from the healthcare vertical on Fridays — user noted compliance review cycle runs Thursday/Friday and decision-makers are unavailable.',
    source: 'chat',
    usefulnessScore: 0.78,
  },
  {
    content: 'Zendesk API rate limit is 700 req/min for this account tier. Slow down bulk ticket queries to 400 req/min to avoid 429 errors.',
    source: 'tool-result',
    usefulnessScore: 0.89,
    lastUsedAt: '2026-04-15T16:45:00Z',
  },
  {
    content: 'User corrected: "activated" means the customer completed all 3 onboarding milestones (connect integration, run first workflow, invite a teammate) — not just email confirmation.',
    source: 'chat',
    usefulnessScore: 0.97,
    lastUsedAt: '2026-04-21T08:20:00Z',
  },
  {
    content: 'Stripe webhook signature verification fails in the dev environment because the test secret is rotated monthly. Fetch fresh secret from Vault before processing.',
    source: 'tool-result',
    usefulnessScore: 0.83,
    lastUsedAt: '2026-03-30T10:00:00Z',
  },
  {
    content: 'Noticed pattern: tickets tagged "billing dispute" that are under $50 are almost always resolved by applying a one-time courtesy credit. Confirmed with user — proceed autonomously for amounts ≤ $50.',
    source: 'reflection',
    usefulnessScore: 0.91,
    lastUsedAt: '2026-04-19T13:30:00Z',
  },
  {
    content: 'User\'s timezone is America/Los_Angeles. All scheduled tasks and deadline references default to PT unless explicitly stated.',
    source: 'chat',
    usefulnessScore: 0.99,
    lastUsedAt: '2026-04-23T07:00:00Z',
  },
  {
    content: 'The Google Sheets export for weekly pipeline reports should always include columns: Lead Name, Company, ICP Score, Stage, Next Action, Owner. User rejected format without Owner column twice.',
    source: 'reflection',
    usefulnessScore: 0.88,
    lastUsedAt: '2026-04-14T17:00:00Z',
  },
  {
    content: 'Slack channel #billing-escalations requires @here ping only for disputes > $500. Using @channel caused complaints from the team.',
    source: 'chat',
    usefulnessScore: 0.76,
    lastUsedAt: '2026-03-25T12:15:00Z',
  },
  {
    content: 'Failed Hubspot contact enrichment calls (status 422) typically mean the email domain is a free provider (gmail, yahoo). Skip enrichment and mark lead as "SMB unqualified" automatically.',
    source: 'tool-result',
    usefulnessScore: 0.80,
    lastUsedAt: '2026-04-11T09:45:00Z',
  },
]

// Simple deterministic hash of a string → integer
function simpleHash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

// Spread createdAt dates over the last ~90 days deterministically
function deterministicDate(seed: number, index: number): string {
  const msBack = ((seed * (index + 1)) % (90 * 24 * 60 * 60 * 1000))
  return new Date(Date.now() - msBack).toISOString()
}

export function generateMockAgentMemories(internalAgentId: string): AgentMemory[] {
  const hash = simpleHash(internalAgentId)
  // Pick 6–10 entries depending on the agent
  const count = 6 + (hash % 5)
  const startIndex = hash % MEMORY_POOL.length

  const memories: AgentMemory[] = []
  for (let i = 0; i < count; i++) {
    const poolIndex = (startIndex + i) % MEMORY_POOL.length
    const poolEntry = MEMORY_POOL[poolIndex]
    memories.push({
      id: `mem-${internalAgentId}-${poolIndex}-${hash + i}`,
      ...poolEntry,
      createdAt: deterministicDate(hash, i),
    })
  }

  return memories
}

// Mutable store used by handlers — DELETE mutations persist within a session
export const mockAgentMemoriesStore = new Map<string, AgentMemory[]>()
