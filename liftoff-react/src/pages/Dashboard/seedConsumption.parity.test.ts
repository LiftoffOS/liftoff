import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGES_DIR = join(__dirname)

/** Pages that receive a message from the home composer's @mention router. They
 *  are found by the marker rather than listed, so a new destination is covered
 *  the day it is added. */
function seedConsumers(): { name: string; source: string }[] {
  return readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && !f.endsWith('.stories.tsx'))
    .map((name) => ({ name, source: readFileSync(join(PAGES_DIR, name), 'utf8') }))
    .filter(({ source }) => source.includes('seedConsumedRef'))
}

/** The line that decides whether the seeded message gets sent. */
function seedGuards(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => line.includes('hasSeed') && line.includes('seedConsumedRef'))
}

describe('@mention seed consumption', () => {
  const consumers = seedConsumers()

  it('finds the destination pages at all', () => {
    // Guards the guard: if the marker is renamed, every assertion below would
    // pass by testing nothing.
    expect(consumers.length).toBeGreaterThanOrEqual(4)
    expect(consumers.map((c) => c.name).sort()).toContain('LiftoffPage.tsx')
  })

  // This shipped broken on all four destinations at once, so it is worth
  // stating plainly. useChatStreaming.handleSend CREATES the thread when there
  // is none. A seed effect that waits for currentThreadId therefore deadlocks:
  // the only call that would produce a thread is the call being held back until
  // one exists. On the pages that auto-create a greeting thread the deadlock is
  // total, because that effect deliberately stands down while a seed is
  // pending, so nothing at all is left to create one.
  //
  // Symptom when this regresses: the composer routes to the destination page
  // and the message silently never arrives.
  it.each(seedConsumers())(
    '$name does not gate the seeded send on an existing thread',
    ({ source }) => {
      const guards = seedGuards(source)
      expect(guards.length).toBeGreaterThan(0)
      for (const guard of guards) {
        expect(guard).not.toContain('currentThreadId')
      }
    },
  )

  it.each(seedConsumers())('$name marks the seed consumed before sending', ({ source }) => {
    // Set synchronously ahead of the await, or a double mount sends twice.
    const assignmentIndex = source.indexOf('seedConsumedRef.current = true')
    const sendIndex = source.indexOf('chat.handleSend(seedState')
    expect(assignmentIndex).toBeGreaterThan(-1)
    expect(sendIndex).toBeGreaterThan(assignmentIndex)
  })

  // The scrub takes the SEED, and only the seed.
  //
  // It used to be `state: null`, which could not tell a one-shot instruction
  // apart from identity and threw away both. That cost two things: the open
  // conversation, so a refresh after sending landed on a blank chat; and on
  // AgentChatPage the `agentId`, which arrives as router state with no query
  // param — so the page's own redirect fired and an @mention from the home
  // composer bounced the person to the teams list mid-send.
  //
  // consumeSeed (lib/chatNavState) is what draws that line, and is unit-tested
  // there. This only pins down that every destination page scrubs THROUGH it.
  it.each(seedConsumers())('$name scrubs the router state so a reload cannot replay', ({ source }) => {
    expect(source).toMatch(/replace:\s*true/)
    expect(source).toMatch(/state:\s*consumeSeed\(location\.state\)/)
    expect(source).not.toMatch(/state:\s*null/)
  })

  // The seed effect scrubs the router state BEFORE it sends, so `hasSeed` is
  // false again one render later while the thread the send is creating does
  // not exist yet. A greeting effect gated on `hasSeed` alone fires straight
  // into that gap, and the person who arrived with something to say is greeted
  // as though they had said nothing — plus a second stream on the way in.
  //
  // Symptom when this regresses: a "how can I help" bubble sitting above the
  // message the person had already sent from the home composer.
  it.each(seedConsumers().filter(({ source }) => source.includes('startGreeting')))(
    '$name does not greet over a seed it has already consumed',
    ({ source }) => {
      expect(source).toMatch(/if \(seedConsumedRef\.current\) return/)
    },
  )
})
