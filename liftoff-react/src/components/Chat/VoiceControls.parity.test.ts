// Every chat surface gets the same voice controls.
//
// This exists because they did not. The styles lived in the shared ChatPage.css
// from the start, but each page hand-rolled its own header markup and its own
// dictation wiring — so the voice-mode toggle was added to the team chat and
// silently missing from the plan and from insights, and three identical copies
// of the microphone button drifted apart.
//
// A rendering test would not catch the real failure, which is a NEW page
// appearing with a composer and no voice. So this reads the source: any file
// that renders a chat composer must get its voice from the shared hook and the
// shared controls, not from its own copy.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PAGES_DIR = join(__dirname, '..', '..', 'pages', 'Dashboard')

/** A page that streams replies in place is a chat surface, whatever it is
 *  called. Rendering the composer is not enough on its own: the dashboard home
 *  composer routes the message to another page instead of answering it, so it
 *  has no reply to speak and no run to stop, and the voice-mode toggle would
 *  control nothing. `useChatStreaming` is what actually marks a surface that
 *  owns a conversation. */
function chatSurfaces(): { name: string; source: string }[] {
  return readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && !f.endsWith('.stories.tsx'))
    .map((name) => ({ name, source: readFileSync(join(PAGES_DIR, name), 'utf8') }))
    .filter(({ source }) => source.includes('Chat/ChatInput') && source.includes('useChatStreaming('))
}

describe('voice control parity', () => {
  const surfaces = chatSurfaces()

  it('finds the chat surfaces at all', () => {
    // Guards the guard: a rename that broke the detection above would otherwise
    // make every assertion below pass by testing nothing.
    expect(surfaces.length).toBeGreaterThanOrEqual(3)
    expect(surfaces.map((s) => s.name).sort()).toContain('AgentChatPage.tsx')
  })

  // Note the angle bracket: it has to be RENDERED, not merely imported. Without
  // it this file passed with the toggle deleted from a page, because the import
  // line still mentioned the name — a guard that guards nothing.
  it.each(chatSurfaces())('$name renders the voice mode toggle', ({ source }) => {
    expect(source).toContain('<VoiceModeToggle')
  })

  it.each(chatSurfaces())('$name renders the microphone', ({ source }) => {
    expect(source).toContain('<VoiceInputButton')
  })

  it.each(chatSurfaces())('$name gets its behaviour from the shared hook', ({ source }) => {
    expect(source).toContain('useVoiceChat(')
    // Reaching past the shared hook is how the wiring drifted last time: a page
    // that calls these directly has its own copy of the rules again.
    expect(source).not.toContain("from '../../hooks/useDictation'")
    expect(source).not.toContain("from '../../hooks/useSpokenReplies'")
  })

  it.each(chatSurfaces())('$name does not hand-roll the control markup', ({ source }) => {
    expect(source).not.toContain('chat-page__voice-toggle')
    expect(source).not.toContain('chat-input__left-action--listening')
  })
})
