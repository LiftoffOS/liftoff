import { http, HttpResponse } from 'msw'
import type { WorkspaceAiVendor, WorkspaceAiVendorCoding, WorkspaceAiVendorModels } from '../../services/tenants'
import { maskApiKey, type AiProviderKey, type AiProviderKeyVendor } from '../../services/aiProviderKeys'

// The full-distill-status poll and restart-full-distill handlers that lived
// here mocked the onboarding provisioning loader. Both endpoints are gone with
// the in-onboarding hire (platform-backend ADR-050), and a mock for a route
// that no longer exists is worse than none: it makes a removed call look
// healthy in dev while 404ing in production.

// Per-tenant workspace AI vendor, so a Settings edit is visible to the
// per-AI-team override card in the same mock session.
const workspaceAiVendors = new Map<string, WorkspaceAiVendor>()

// What each named provider brings, as the registry names it: models with the
// Frontier one first, and the coding tool. No 'default' entry in either:
// Liftoff Managed does not show what it routes to.
const WORKSPACE_AI_VENDOR_MODELS: WorkspaceAiVendorModels = {
  anthropic: ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'],
  openai: ['GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna'],
  google: ['Gemini 3.1 Pro Preview', 'Gemini 3.5 Flash', 'Gemini 3.1 Flash Lite'],
  grok: ['Grok 4.6', 'Grok 4.3', 'Grok 4.20'],
  deepseek: ['DeepSeek V4 Pro', 'DeepSeek V4.1 Flash'],
  glm: ['GLM 5.2', 'GLM 5 Turbo', 'GLM 4.7 Flash'],
  kimi: ['Kimi K3', 'Kimi K2.6'],
  minimax: ['MiniMax M3', 'MiniMax M2.7'],
  qwen: ['Qwen 3.8 Max', 'Qwen 3.7 Plus', 'Qwen 3.7 Flash'],
}

const WORKSPACE_AI_VENDOR_CODING: WorkspaceAiVendorCoding = {
  anthropic: { tool: 'Claude Code' },
  openai: { tool: 'Codex' },
  google: { tool: 'Gemini CLI' },
  grok: { tool: 'OpenCode', model: 'Grok 4.6' },
  deepseek: { tool: 'OpenCode', model: 'DeepSeek V4 Pro' },
  glm: { tool: 'OpenCode', model: 'GLM 5.2' },
  kimi: { tool: 'OpenCode', model: 'Kimi K3' },
  minimax: { tool: 'OpenCode', model: 'MiniMax M3' },
  qwen: { tool: 'OpenCode', model: 'Qwen 3.8 Max' },
}

// Per-tenant BYO provider keys. Only the redacted hint is kept, which is the
// whole point of the contract: the mock cannot hand a saved secret back to the
// card any more than the real backend can, so a test that expects to read one
// fails here rather than passing against a mock that is more generous than
// production.
const aiProviderKeys = new Map<string, Map<AiProviderKeyVendor, AiProviderKey>>()

export const tenantsHandlers = [
  // Workspace AI vendor. Read by the Settings card AND by the per-AI-team
  // AI Provider Override card, which cannot mark its inherited option with the
  // "Workspace Default" badge until this resolves. Seeded to a NON-'default'
  // vendor on purpose: with 'default' the badge lands on Liftoff Managed and
  // hides the interesting case, where inherit and Liftoff Managed are two
  // different rows.
  http.get('*/api/tenants/:tenantId/workspace-ai', ({ params }) => {
    const tenantId = String(params.tenantId)
    return HttpResponse.json({
      vendor: workspaceAiVendors.get(tenantId) ?? 'anthropic',
      vendorModels: WORKSPACE_AI_VENDOR_MODELS,
      vendorCoding: WORKSPACE_AI_VENDOR_CODING,
    })
  }),

  // Settings writes the selection through the generic tenant PATCH.
  http.patch('*/api/tenants/:tenantId', async ({ params, request }) => {
    const tenantId = String(params.tenantId)
    const body = await request.json() as { workspaceAiVendor?: WorkspaceAiVendor }
    if (body?.workspaceAiVendor) {
      workspaceAiVendors.set(tenantId, body.workspaceAiVendor)
    }
    return HttpResponse.json({ id: tenantId, ...body })
  }),

  // BYO AI provider keys. Empty until something is saved, so the card's
  // first-run state (four blank fields, no hints) is the default.
  http.get('*/api/tenants/:tenantId/ai-provider-keys', ({ params }) => {
    const stored = aiProviderKeys.get(String(params.tenantId))
    return HttpResponse.json({ keys: stored ? [...stored.values()] : [] })
  }),

  // Write-only merge: a vendor the body omits keeps the key it already has.
  //
  // MOCK-ONLY AFFORDANCE: a key containing the word "revoked" is stored with
  // status 'revoked'. The real backend verifies on save and rejects a key that
  // does not work, so that status is only ever reached later, when a runtime
  // 401 says a working key has stopped working. There is no way to reach it
  // from the UI, and a state nobody can reach is a state nobody checks, so the
  // mock provides a door: save `sk-ant-revoked-demo-key` to see how the card
  // reports a dead key.
  http.put('*/api/tenants/:tenantId/ai-provider-keys', async ({ params, request }) => {
    const tenantId = String(params.tenantId)
    const body = await request.json() as {
      keys?: Partial<Record<AiProviderKeyVendor, string | null>>
    }
    const stored = aiProviderKeys.get(tenantId) ?? new Map<AiProviderKeyVendor, AiProviderKey>()
    const now = new Date().toISOString()
    for (const [vendor, secret] of Object.entries(body?.keys ?? {})) {
      // null is the clear button: drop the key entirely. An empty string is
      // NOT a removal, matching the real endpoint, so a field the user focused
      // and left cannot delete anything.
      if (secret === null) {
        stored.delete(vendor as AiProviderKeyVendor)
        continue
      }
      const raw = String(secret)
      const hint = maskApiKey(raw)
      if (!hint) continue
      const revoked = raw.toLowerCase().includes('revoked')
      stored.set(vendor as AiProviderKeyVendor, {
        vendor: vendor as AiProviderKeyVendor,
        hint,
        status: revoked ? 'revoked' : 'valid',
        updatedAt: now,
        lastVerifiedAt: revoked ? null : now,
      })
    }
    aiProviderKeys.set(tenantId, stored)
    return HttpResponse.json({ keys: [...stored.values()] })
  }),
]
