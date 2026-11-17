// Workspace AI provider vocabulary, shared by the workspace-level card on
// SettingsPage and the per-AI-team override card on AgentUpdatePage. It lives
// here rather than on either page so neither page has to import from the other.

import type { DropdownOption } from '../components/Dropdown'
import type { WorkspaceAiVendor } from '../services/tenants'

// Option order (product decision): Liftoff Managed first, then the mainstream
// providers (Anthropic, OpenAI, Google, Grok), then the OpenRouter-served
// open-weights vendors alphabetically (DeepSeek, GLM, Kimi, MiniMax, Qwen).
//
// Grok sits with the mainstream group rather than alphabetically among the
// open-weights vendors. It reaches us THROUGH OpenRouter, but so does nothing
// else in that group — the grouping here is how customers recognise the brand,
// not how the request is routed.
export const WORKSPACE_AI_OPTIONS: Array<{ value: WorkspaceAiVendor; label: string; badge?: string }> = [
  { value: 'default', label: 'Liftoff Managed', badge: 'Recommended' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'grok', label: 'Grok' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'glm', label: 'GLM' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'xiaomi', label: 'Xiaomi' },
]

export const WORKSPACE_DEFAULT_BADGE = 'Workspace Default'

// The per-AI-team option list. "Inherit" is not an extra row duplicating a
// vendor already in the list: it IS the vendor the workspace is set to, so that
// row is badged instead. Choosing it clears the override (see AgentUpdatePage).
// The badge replaces 'Recommended' only where the two would land on the same
// row; every other row keeps whatever badge it already had.
// `workspaceVendor` is undefined while the workspace query is in flight, in
// which case nothing is badged rather than marking a row we have not read yet.
export function buildTeamAiProviderOptions(workspaceVendor?: WorkspaceAiVendor): DropdownOption[] {
  return WORKSPACE_AI_OPTIONS.map(opt =>
    opt.value === workspaceVendor ? { ...opt, badge: WORKSPACE_DEFAULT_BADGE } : opt,
  )
}
