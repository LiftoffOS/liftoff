// Workspace-level AI provider API keys (bring your own key).
//
// services/tenants.ts `workspace-ai` answers WHICH provider a workspace's AI
// teams prioritise. This module answers the separate question of WHOSE account
// pays for it: a key stored here is the customer's own credential with that
// provider, used in place of the Liftoff-managed pool.
//
// Keys are WRITE-ONLY, the same rule the custom MCP server credentials follow
// (services/customMcpServers.ts). A save sends the raw secret exactly once;
// every read afterwards returns only `hint`, a partially redacted form the
// settings card can show without the browser ever holding the secret again.
// Redaction is a property of what is READ BACK, not of what is typed: a key
// being pasted is plain text, because a field nobody can read is a field
// nobody can check before saving. Omitting a
// provider from a write means "leave the stored value alone", never "clear it",
// so a user who rotates one key cannot silently drop the other three. Clearing
// is its own signal: an explicit null, sent only by the card's clear button.

import { api } from './api'

export type AiProviderKeyVendor = 'anthropic' | 'google' | 'openai' | 'xai'

// Display order is the order the providers are offered in the card. `xai` is
// the vendor id here rather than the `grok` used by constants/workspaceAi: that
// list names the model brand a workspace routes to, this one names the account
// the key belongs to, and the two vocabularies are deliberately not merged.
export const AI_PROVIDER_KEY_VENDORS: Array<{ value: AiProviderKeyVendor; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  // 'Google Gemini', not 'Google': the account a key belongs to is a Google
  // Cloud one, but what a workspace buys with it is Gemini capacity, and a
  // field labelled 'Google' beside three model vendors reads like the company
  // rather than the model.
  { value: 'google', label: 'Google Gemini' },
  { value: 'openai', label: 'OpenAI' },
  // 'Grok', not 'xAI'. The vendor id stays `xai` because that is the account
  // the key belongs to and an xAI key cannot settle an OpenRouter invoice —
  // but the label sits beside three model names, and Grok is the model.
  { value: 'xai', label: 'Grok' },
]

/**
 * Whether the stored key still works.
 *
 * There is no 'unverified'. A key is checked against its provider on the way in
 * and a write that fails is rejected outright, so nothing unchecked is ever
 * stored. 'revoked' is therefore never written by the save path: it is what a
 * key that WAS valid decays into once someone revokes it at the provider, it
 * expires, or the account hits a spend cap. That signal reaches us from the
 * runtime, when an agent's call comes back 401, and it has to be shown here
 * or the card keeps reporting a key that no longer works.
 */
export type AiProviderKeyStatus = 'valid' | 'revoked'

export interface AiProviderKey {
  vendor: AiProviderKeyVendor
  /** Partially redacted form of the stored key, for example "sk-ant••••••••3f2x".
   *  This is what the card puts in the field when it is reopened, so it has to
   *  be recognisable as the key the user saved without being usable as one.
   *  null when nothing is stored. */
  hint: string | null
  status: AiProviderKeyStatus
  updatedAt: string | null
  /** Last time the provider confirmed the key works, whether at save or from a
   *  later runtime call. Not displayed today; it is what makes a stale 'valid'
   *  diagnosable. */
  lastVerifiedAt: string | null
}

/**
 * Write payload. Three states per vendor:
 *
 *   absent  keep whatever is stored
 *   string  store this key, replacing any current one
 *   null    REMOVE the stored key, so the workspace falls back to Liftoff's
 *           managed pool for that provider
 *
 * An empty string is deliberately not a removal: a field the user focused and
 * left submits nothing, and treating that as a delete would make a stray click
 * destructive. Removal is only ever the explicit null the clear button sends.
 */
export type AiProviderKeyUpdate = Partial<Record<AiProviderKeyVendor, string | null>>

/**
 * The redaction the stored hint uses. The server produces the hint a real read
 * returns, so this is not on the display path; it lives beside the type it
 * describes so the mock backend and its tests cannot drift from the shape the
 * card is written against.
 *
 * Six leading characters and four trailing ones survive; everything between
 * them goes. The head is the vendor's own prefix (`sk-ant`, `AIzaSy`, `xai-`),
 * which is identical across every key that vendor issues and so gives nothing
 * away, and the tail is what lets someone tell which of their keys is stored.
 * The interior, which is the whole of the secret, never leaves the server.
 *
 * The mask is a fixed eight bullets rather than one per omitted character, so
 * the hint does not disclose how long the key was.
 *
 * Returns null for anything too short to be a real provider key: the shortest
 * of the four vendors' formats is comfortably past this, and redacting a short
 * string well is not possible.
 */
export function maskApiKey(key: string): string | null {
  const trimmed = key.trim()
  if (trimmed.length < 12) return null
  return `${trimmed.slice(0, 6)}${'•'.repeat(8)}${trimmed.slice(-4)}`
}

export async function getAiProviderKeys(tenantId: string): Promise<AiProviderKey[]> {
  const res = await api.get<{ keys: AiProviderKey[] }>(
    `/api/tenants/${tenantId}/ai-provider-keys`,
  )
  return res.keys ?? []
}

export async function updateAiProviderKeys(
  tenantId: string,
  keys: AiProviderKeyUpdate,
): Promise<AiProviderKey[]> {
  const res = await api.put<{ keys: AiProviderKey[] }>(
    `/api/tenants/${tenantId}/ai-provider-keys`,
    { keys },
  )
  return res.keys ?? []
}
