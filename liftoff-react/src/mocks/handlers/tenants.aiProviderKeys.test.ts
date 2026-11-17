// The BYO provider-key contract, exercised through the real handler list on
// the shared MSW server.
//
// What is being pinned here is not the mock, it is the shape the settings card
// is written against: a read hands back redacted hints and never the secret,
// and a write is a merge rather than a replace. Both are easy to implement the
// other way round on the backend, and either mistake reaches a user as a lost
// key or a leaked one.

import { describe, it, expect } from 'vitest'
import {
  getAiProviderKeys,
  updateAiProviderKeys,
  maskApiKey,
} from '../../services/aiProviderKeys'

const ANTHROPIC_KEY = 'sk-ant-api03-not-a-real-key-3f2x'
const OPENAI_KEY = 'sk-proj-not-a-real-key-9qLm'

describe('ai-provider-keys mock handler', () => {
  it('starts empty, so the card opens with four blank fields', async () => {
    expect(await getAiProviderKeys('tenant-keys-empty')).toEqual([])
  })

  it('reads back a partial redaction, never the saved key', async () => {
    const tenant = 'tenant-keys-redaction'
    await updateAiProviderKeys(tenant, { anthropic: ANTHROPIC_KEY })

    const keys = await getAiProviderKeys(tenant)
    const anthropic = keys.find(k => k.vendor === 'anthropic')

    expect(anthropic?.hint).toBe('sk-ant••••••••3f2x')
    expect(anthropic?.hint).not.toBe(ANTHROPIC_KEY)

    // What survives is the vendor prefix, which every Anthropic key shares, and
    // the tail, which is only enough to tell one of your own keys from another.
    // The interior is the secret and none of it comes back.
    expect(anthropic?.hint).not.toContain('api03')
    expect(anthropic?.hint).not.toContain('not-a-real-key')

    // Most of the key is gone, and the redaction is a fixed width so it does
    // not disclose how long the key was.
    const revealed = anthropic!.hint!.replace(/•/g, '')
    expect(revealed.length).toBeLessThan(ANTHROPIC_KEY.length / 2)
    expect(maskApiKey(`${ANTHROPIC_KEY}-and-then-some-more`)).toHaveLength(
      anthropic!.hint!.length,
    )
  })

  it('leaves the other providers alone when one key is rotated', async () => {
    const tenant = 'tenant-keys-merge'
    await updateAiProviderKeys(tenant, { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY })
    await updateAiProviderKeys(tenant, { openai: 'sk-proj-rotated-key-7ttZ' })

    const keys = await getAiProviderKeys(tenant)
    expect(keys.find(k => k.vendor === 'anthropic')?.hint).toBe('sk-ant••••••••3f2x')
    expect(keys.find(k => k.vendor === 'openai')?.hint).toBe('sk-pro••••••••7ttZ')
  })

  it('keeps every provider the card offers addressable', async () => {
    const tenant = 'tenant-keys-all-vendors'
    await updateAiProviderKeys(tenant, {
      anthropic: 'anthropic-key-aaaa',
      google: 'google-key-bbbb',
      openai: 'openai-key-cccc',
      xai: 'xai-key-dddd',
    })

    const keys = await getAiProviderKeys(tenant)
    expect(keys.map(k => k.vendor).sort()).toEqual(['anthropic', 'google', 'openai', 'xai'])
  })

  it('refuses to claim a key is stored when it is too short to redact', () => {
    expect(maskApiKey('abc')).toBeNull()
    expect(maskApiKey('  ')).toBeNull()
    // Below the threshold the head and tail would overlap and hand back most of
    // the string. No real provider key is anywhere near this short.
    expect(maskApiKey('sk-short-1')).toBeNull()
  })
})
