import type { ComponentType } from 'react'
import { describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { composeStories } from '@storybook/react-vite'

/**
 * Every story must render.
 *
 * A story that throws is invisible until somebody opens Storybook, so these
 * rot quietly: a component grows a `useToast` or a `useAuth` call, the story
 * that has only a QueryClientProvider starts throwing, and nothing says so.
 * Two were broken this way before this test existed.
 *
 * Discovered by glob rather than listed, so a new story is covered the day it
 * is written.
 */
const storyModules = import.meta.glob('../**/*.stories.tsx', { eager: true })

describe('storybook stories render', () => {
  const entries = Object.entries(storyModules)

  it('finds the stories at all', () => {
    // Guards the guard: a glob that matches nothing would make every
    // assertion below pass by testing nothing.
    expect(entries.length).toBeGreaterThan(5)
  })

  for (const [path, mod] of entries) {
    const composed = composeStories(mod as Parameters<typeof composeStories>[0])
    // The glob hands over untyped modules, so composeStories cannot say what
    // shape each story has; the cast is only about naming what render already
    // receives.
    for (const [name, Story] of Object.entries(composed) as [string, ComponentType][]) {
      it(`${path.replace('../', '')} > ${name}`, () => {
        render(<Story />)
        cleanup()
      })
    }
  }
})
